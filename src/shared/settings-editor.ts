import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    type ChatInputCommandInteraction,
    type GuildMember,
    type Interaction,
    LabelBuilder,
    type MessageActionRowComponentBuilder,
    type ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import { ZodError, type z } from "zod";
import type { Context } from "../core/plugin";
import { requireManageGuild } from "./discord";
import { UserError } from "./errors";
import type { card } from "./messages";
import type { Settings } from "./validation";

export const editorRow = (...components: MessageActionRowComponentBuilder[]) =>
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
        ...components,
    );

export function editorInput(
    label: string,
    id: string,
    value: string,
    maxLength: number,
    paragraph = false,
    description?: string,
) {
    const field = new LabelBuilder().setLabel(label).setTextInputComponent(
        new TextInputBuilder()
            .setCustomId(id)
            .setValue(value)
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(maxLength)
            .setStyle(
                paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short,
            ),
    );
    if (description) field.setDescription(description);
    return field;
}

export function editorInteger(
    value: string,
    label: string,
    min: number,
    max: number,
): number {
    const trimmed = value.trim();
    const number = Number(trimmed);
    if (
        !/^\d+$/.test(trimmed) ||
        !Number.isSafeInteger(number) ||
        number < min ||
        number > max
    )
        throw new UserError(`Enter a whole ${label} from ${min} to ${max}.`);
    return number;
}

export interface EditorSession<C, S> {
    botId: string;
    guildId: string;
    userId: string;
    expires: number;
    revision: string | null;
    config: C;
    state: S;
}
export type EditorInteraction = Extract<
    Interaction<"cached">,
    { customId: string }
>;
export interface EditorChange<S> {
    state?: S;
    patch?: Record<string, unknown>;
    notice?: string;
}

/** Shared session rules for new admin editors. Feature files own the UI and
 * settings; this class owns authorization, expiry, acknowledgements and conflicts.
 * Every rendered view gets a one-use token. Opening a modal leaves its parent
 * usable if cancelled; saving still checks the database revision.
 */
export abstract class SettingsEditor<C extends Settings, S> {
    private readonly sessions = new Map<string, EditorSession<C, S>>();
    constructor(
        protected readonly pluginId: string,
        private readonly schema: z.ZodType<C>,
        private readonly command: string,
        private readonly initialState: () => S,
        private readonly now: () => number = Date.now,
    ) {}

    protected abstract render(
        session: EditorSession<C, S>,
        member: GuildMember,
        notice?: string,
    ): ReturnType<typeof card>;
    protected abstract update(
        context: Context,
        session: EditorSession<C, S>,
        interaction: EditorInteraction,
        action: string,
    ): Promise<EditorChange<S>>;
    protected abstract form(
        session: EditorSession<C, S>,
        action: string,
    ): { modal: ModalBuilder; state: S } | undefined;

    private remember(session: EditorSession<C, S>): string {
        for (const [key, value] of this.sessions)
            if (value.expires <= this.now()) this.sessions.delete(key);
        if (this.sessions.size >= 1000) {
            const oldest = this.sessions.keys().next().value;
            if (oldest) this.sessions.delete(oldest);
        }
        const id = crypto.randomUUID();
        this.sessions.set(id, session);
        return id;
    }

    protected controls(session: EditorSession<C, S>) {
        const token = this.remember(session);
        const id = (action: string) =>
            `${this.pluginId}:editor:${token}:${action}`;
        return {
            id,
            button: (
                action: string,
                label: string,
                style = ButtonStyle.Secondary,
            ) =>
                new ButtonBuilder()
                    .setCustomId(id(action))
                    .setLabel(label)
                    .setStyle(style),
        };
    }

    private async fresh(context: Context, session: EditorSession<C, S>) {
        const stored = await context.settings.raw(
            session.guildId,
            this.pluginId,
        );
        return {
            ...session,
            revision: stored.revision,
            config: this.schema.parse({
                ...stored.config,
                enabled: stored.enabled,
            }),
        };
    }

    /** External effects such as publishing a panel must use the version previewed. */
    protected async assertCurrent(
        context: Context,
        session: EditorSession<C, S>,
    ) {
        if (
            (await context.settings.raw(session.guildId, this.pluginId))
                .revision !== session.revision
        )
            throw new UserError(
                "Settings changed. Refresh and review them before continuing.",
            );
    }

    async open(
        context: Context,
        interaction: ChatInputCommandInteraction<"cached">,
    ): Promise<void> {
        requireManageGuild(interaction);
        const session = await this.fresh(context, {
            botId: context.botId,
            guildId: interaction.guildId,
            userId: interaction.user.id,
            expires: this.now() + 15 * 60 * 1000,
            revision: null,
            config: this.schema.parse({}),
            state: this.initialState(),
        });
        await interaction.editReply(this.render(session, interaction.member));
    }

    async handle(
        context: Context,
        interaction: Interaction<"cached">,
    ): Promise<void> {
        if (!interaction.isMessageComponent() && !interaction.isModalSubmit())
            return;
        requireManageGuild(interaction);
        const [plugin, area, id, action, extra] =
            interaction.customId.split(":");
        const session = id ? this.sessions.get(id) : undefined;
        if (
            plugin !== this.pluginId ||
            area !== "editor" ||
            extra ||
            !id ||
            !action ||
            !session ||
            session.expires <= this.now()
        )
            throw new UserError(
                `This editor is outdated or expired. Open ${this.command} again.`,
            );
        if (
            session.botId !== context.botId ||
            session.guildId !== interaction.guildId ||
            session.userId !== interaction.user.id
        )
            throw new UserError(
                `This editor belongs to another administrator. Open ${this.command} for your own panel.`,
            );
        if (
            (interaction.isModalSubmit() && !interaction.isFromMessage()) ||
            interaction.message?.author.id !== context.botId
        )
            throw new UserError("This editor message is no longer valid.");

        // Modals must be the initial acknowledgement, before any database requests.
        const form = interaction.isButton()
            ? this.form(session, action)
            : undefined;
        if (form && interaction.isButton()) {
            const modalId = this.remember({ ...session, state: form.state });
            await interaction.showModal(
                form.modal.setCustomId(
                    `${this.pluginId}:editor:${modalId}:submit`,
                ),
            );
            return;
        }
        this.sessions.delete(id);
        await interaction.deferUpdate();
        try {
            const change: EditorChange<S> =
                interaction.isButton() && action === "refresh"
                    ? { state: this.initialState() }
                    : await this.update(context, session, interaction, action);
            let next = { ...session, state: change.state ?? session.state };
            if (change.patch)
                await context.settings.patch(
                    session.guildId,
                    this.pluginId,
                    this.schema,
                    change.patch,
                    session.revision,
                );
            if (change.patch || action === "refresh")
                next = await this.fresh(context, next);
            await interaction.editReply(
                this.render(next, interaction.member, change.notice),
            );
        } catch (error) {
            if (!(error instanceof UserError) && !(error instanceof ZodError))
                throw error;
            const current = await this.fresh(context, {
                ...session,
                state: this.initialState(),
            });
            const message =
                current.revision !== session.revision
                    ? "Settings changed while this editor was open. Nothing from this edit was saved. Review the current settings."
                    : error instanceof ZodError
                      ? error.issues.map((issue) => issue.message).join("; ")
                      : error.message;
            await interaction.editReply(
                this.render(current, interaction.member, `⚠️ ${message}`),
            );
        }
    }
}
