import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Interaction,
  LabelBuilder,
  type MessageActionRowComponentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { requireManageGuild, sendableChannel } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, clipText } from "../../shared/messages";
import { type WelcomeSettings, welcomeSchema } from "./config";
import {
  type GreetingKind,
  greetingCard,
  greetingFields,
  greetingTemplate,
} from "./presentation";

interface Session {
  botId: string;
  guildId: string;
  userId: string;
  expires: number;
  revision: string | null;
  config: WelcomeSettings;
  kind: GreetingKind;
  view: "home" | "channel" | "preview" | "modal";
  /** Unsaved text is previewed before the administrator commits it. */
  draft?: string;
}
const EXPIRED =
  "This greeting editor is outdated or expired. Open /welcome settings again.";
const row = (...components: MessageActionRowComponentBuilder[]) =>
  new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
    ...components,
  );

/** Every view is bound to its admin, guild and bot. One-use view tokens prevent
 * double clicks, while database revisions protect against other admin editors.
 * Opening a modal retains the old view so cancelling never breaks its buttons.
 */
export class WelcomeSettingsEditor {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly now: () => number = Date.now) {}

  private remember(session: Session): string {
    for (const [id, entry] of this.sessions)
      if (entry.expires <= this.now()) this.sessions.delete(id);
    if (this.sessions.size >= 1000) {
      const oldest = this.sessions.keys().next().value;
      if (oldest) this.sessions.delete(oldest);
    }
    const id = crypto.randomUUID();
    this.sessions.set(id, session);
    return id;
  }

  private async fresh(context: Context, session: Session): Promise<Session> {
    const stored = await context.settings.raw(
      session.guildId,
      "welcome_goodbye",
    );
    return {
      ...session,
      revision: stored.revision,
      config: welcomeSchema.parse({
        ...stored.config,
        enabled: stored.enabled,
      }),
    };
  }

  async open(
    context: Context,
    interaction: ChatInputCommandInteraction<"cached">,
    kind: GreetingKind = "welcome",
    notice?: string,
    view: "home" | "preview" = "home",
  ): Promise<void> {
    requireManageGuild(interaction);
    const session = await this.fresh(context, {
      botId: context.botId,
      guildId: interaction.guildId,
      userId: interaction.user.id,
      expires: this.now() + 15 * 60 * 1000,
      revision: null,
      config: welcomeSchema.parse({}),
      kind,
      view,
    });
    await interaction.editReply(
      this.render(session, interaction.member, notice),
    );
  }

  private render(session: Session, member: GuildMember, notice?: string) {
    const id = this.remember(session);
    const customId = (action: string) =>
      `welcome_goodbye:editor:${id}:${action}`;
    const button = (
      action: string,
      label: string,
      style = ButtonStyle.Secondary,
    ) =>
      new ButtonBuilder()
        .setCustomId(customId(action))
        .setLabel(label)
        .setStyle(style);
    if (session.view === "preview") {
      const preview = greetingCard(
        session.draft === undefined
          ? session.config
          : {
              ...session.config,
              [greetingFields[session.kind].message]: session.draft,
            },
        session.kind,
        member,
        true,
      );
      return {
        ...preview,
        components: [
          ...preview.components,
          row(
            ...(session.draft === undefined
              ? []
              : [button("apply", "Save message", ButtonStyle.Success)]),
            button(
              "message",
              session.draft === undefined ? "Edit message" : "Edit draft",
            ),
            button(
              "back",
              session.draft === undefined ? "Back to editor" : "Discard draft",
            ),
          ),
        ],
      };
    }
    const fields = greetingFields[session.kind];
    const destination = session.config[fields.channel];
    const actions: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
    if (session.view === "channel") {
      actions.push(
        row(
          new ChannelSelectMenuBuilder()
            .setCustomId(customId("destination"))
            .setPlaceholder(`Choose the ${session.kind} channel`)
            .setMinValues(1)
            .setMaxValues(1)
            .setChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            ),
        ),
        row(
          button("clear", `Disable ${session.kind}`).setDisabled(!destination),
          button("back", `Back to ${session.kind}`),
        ),
      );
    } else {
      actions.push(
        row(
          button(
            "welcome",
            "Welcome",
            session.kind === "welcome"
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary,
          )
            .setEmoji("👋")
            .setDisabled(session.kind === "welcome"),
          button(
            "goodbye",
            "Goodbye",
            session.kind === "goodbye"
              ? ButtonStyle.Primary
              : ButtonStyle.Secondary,
          )
            .setEmoji("🚪")
            .setDisabled(session.kind === "goodbye"),
        ),
        row(
          button("message", `Edit ${session.kind} text`, ButtonStyle.Primary),
          button("channel", "Change channel"),
          button("preview", "Preview"),
          button(
            "toggle",
            session.config.enabled ? "Pause both" : "Enable greetings",
          ),
          button("refresh", "Refresh"),
        ),
      );
    }
    // Keep controls visible even for long greetings. The text input and preview
    // always use the complete template; this excerpt is only an overview.
    const template = clipText(
      greetingTemplate(session.config, session.kind),
      350,
    ).replaceAll("```", "`\u200b``");
    return card({
      title: `${fields.label} editor`,
      icon: session.kind === "welcome" ? "👋" : "🚪",
      body: `**Greetings:** ${session.config.enabled ? "Enabled" : "Paused"}\n**${fields.label} channel:** ${destination ? `<#${destination}>` : "Off — choose a channel"}`,
      sections: [
        ...(notice ? [notice] : []),
        session.view === "channel"
          ? "Choose a destination, or turn off this message type. Welcome and goodbye can share a channel. Selecting a channel does not enable paused greetings."
          : `### ${fields.label} text\n\`\`\`text\n${template}\n\`\`\`\n**Edit ${session.kind} text** opens the full message in a text box. **Preview** shows how it looks.`,
        session.view === "channel"
          ? "Channel changes save immediately. Your message text is kept when you disable its channel."
          : `Switch between **Welcome** and **Goodbye** with the buttons below.\n${session.kind === "welcome" ? "Only the arriving member can be notified." : "Goodbye messages never ping anyone."}${session.config.join_role_ids.length ? "\nPausing greetings also pauses this feature's join roles. Level-0 rewards are managed separately." : ""}`,
      ],
      actions,
      footer:
        "Only you can see this · Message edits preview before saving · Editor lasts 15 minutes",
    });
  }

  async handle(
    context: Context,
    interaction: Interaction<"cached">,
  ): Promise<void> {
    if (!interaction.isMessageComponent() && !interaction.isModalSubmit())
      return;
    requireManageGuild(interaction);
    const [plugin, area, id, action, extra] = interaction.customId.split(":");
    const session = id ? this.sessions.get(id) : undefined;
    if (
      plugin !== "welcome_goodbye" ||
      area !== "editor" ||
      extra ||
      !id ||
      !session ||
      session.expires <= this.now()
    )
      throw new UserError(EXPIRED);
    if (
      session.botId !== context.botId ||
      session.guildId !== interaction.guildId ||
      session.userId !== interaction.user.id
    )
      throw new UserError(
        "This editor belongs to another administrator. Open /welcome settings for your own panel.",
      );
    if (interaction.isModalSubmit() && !interaction.isFromMessage())
      throw new UserError(EXPIRED);
    if (interaction.message?.author.id !== context.botId)
      throw new UserError(EXPIRED);
    const fields = greetingFields[session.kind];

    // Show the modal before any I/O, inside Discord's acknowledgement deadline.
    if (
      interaction.isButton() &&
      action === "message" &&
      (session.view === "home" || session.view === "preview")
    ) {
      const modalId = this.remember({ ...session, view: "modal" });
      await interaction.showModal(
        new ModalBuilder()
          .setCustomId(`welcome_goodbye:editor:${modalId}:save`)
          .setTitle(`Edit ${session.kind} message`)
          .addLabelComponents(
            new LabelBuilder()
              .setLabel(`${fields.label} message`)
              .setDescription(
                "{user}, {display_name}, {server}, {member_count}; channels: <#ID>",
              )
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId("message")
                  .setStyle(TextInputStyle.Paragraph)
                  .setMinLength(1)
                  .setMaxLength(1800)
                  .setRequired(true)
                  .setValue(
                    session.draft ??
                      greetingTemplate(session.config, session.kind),
                  ),
              ),
          ),
      );
      return;
    }

    this.sessions.delete(id);
    if (interaction.isModalSubmit()) {
      if (!interaction.isFromMessage()) throw new UserError(EXPIRED);
      await interaction.deferUpdate();
    } else await interaction.deferUpdate();
    try {
      let next = { ...session };
      let patch: Record<string, unknown> | undefined;
      let notice: string | undefined;
      if (
        interaction.isButton() &&
        (action === "welcome" || action === "goodbye") &&
        session.view === "home"
      ) {
        next.kind = action;
      } else if (
        interaction.isModalSubmit() &&
        action === "save" &&
        session.view === "modal"
      ) {
        const template = interaction.fields.getTextInputValue("message").trim();
        if (!template || template.length > 1800)
          throw new UserError(
            "Enter a message between 1 and 1,800 characters.",
          );
        next.draft = template;
        next.view = "preview";
      } else if (
        interaction.isChannelSelectMenu() &&
        action === "destination" &&
        session.view === "channel"
      ) {
        const channelId = interaction.values[0];
        if (!channelId) throw new UserError("Choose one channel.");
        const channel = await sendableChannel(interaction.guild, channelId);
        if (
          channel.type !== ChannelType.GuildText &&
          channel.type !== ChannelType.GuildAnnouncement
        )
          throw new UserError("Choose a server text or announcement channel.");
        patch = { [fields.channel]: channel.id };
        notice = `✓ ${fields.label} channel saved.`;
      } else if (interaction.isButton()) {
        if (action === "back") {
          next.view = "home";
          next.draft = undefined;
        } else if (
          action === "apply" &&
          session.view === "preview" &&
          session.draft !== undefined
        ) {
          patch = { [fields.message]: session.draft };
          next.view = "home";
          next.draft = undefined;
          notice = `✓ ${fields.label} message saved.`;
        } else if (action === "clear" && session.view === "channel") {
          patch = { [fields.channel]: null };
          notice = `✓ ${fields.label} messages are off. Your template is kept.`;
        } else if (action === "channel" && session.view === "home")
          next.view = "channel";
        else if (action === "preview" && session.view === "home")
          next.view = "preview";
        else if (action === "refresh" && session.view === "home")
          next = await this.fresh(context, session);
        else if (action === "toggle" && session.view === "home") {
          patch = { enabled: !session.config.enabled };
          notice = session.config.enabled
            ? "✓ Greetings paused."
            : "✓ Greetings enabled. Messages need a destination channel to be sent.";
        } else throw new UserError(EXPIRED);
      } else throw new UserError(EXPIRED);
      if (patch) {
        await context.settings.patch(
          session.guildId,
          "welcome_goodbye",
          welcomeSchema,
          patch,
          session.revision,
        );
        next = await this.fresh(context, next);
      }
      await interaction.editReply(
        this.render(next, interaction.member, notice),
      );
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      const current = await this.fresh(context, {
        ...session,
        view: "home",
        draft: undefined,
      });
      const message =
        current.revision !== session.revision
          ? "Settings changed while this editor was open. Nothing from this edit was saved. Review the current settings and try again."
          : error.message;
      await interaction.editReply(
        this.render(current, interaction.member, `⚠️ ${message}`),
      );
    }
  }
}
