import {
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    escapeMarkdown,
    type GuildMember,
    ModalBuilder,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { UserError } from "../../shared/errors";
import { card, clipText } from "../../shared/messages";
import {
    type EditorChange,
    type EditorInteraction,
    type EditorSession,
    editorInput,
    editorInteger,
    editorRow,
    SettingsEditor,
} from "../../shared/settings-editor";
import {
    type CounterKind,
    counterDetails,
    counterKinds,
    counterLabel,
    counterName,
    counterSeparatorSchema,
    defaultCounterSeparator,
    type ServerStatsSettings,
    serverStatsSchema,
} from "./config";
import { collectStats } from "./metrics";
import {
    type ServerStatsService,
    statsCategory,
    validateStatsSetup,
} from "./service";

interface State {
    view:
        | "home"
        | "category"
        | "counters"
        | "separators"
        | "supporters"
        | "staff"
        | "goal-modal"
        | "separator-modal"
        | "preview";
    preview?: string[];
    counter?: CounterKind;
}
type Session = EditorSession<ServerStatsSettings, State>;
const roleList = (ids: string[]) =>
    clipText(ids.map((id) => `<@&${id}>`).join(", ") || "Not selected", 500);

export class ServerStatsSettingsEditor extends SettingsEditor<
    ServerStatsSettings,
    State
> {
    constructor(
        private readonly service: ServerStatsService,
        now?: () => number,
    ) {
        super(
            "server_stats",
            serverStatsSchema,
            "/stats settings",
            () => ({ view: "home" }),
            now,
        );
    }

    protected render(session: Session, _member: GuildMember, notice?: string) {
        const { config, state } = session;
        const { button, id } = this.controls(session);
        const actions = [];
        const sections = notice ? [notice] : [];
        if (state.view === "category") {
            sections.push(
                "Pick an existing category. Generated channels follow its visibility and cannot be joined or used for chatting.",
            );
            actions.push(
                editorRow(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(id("category-select"))
                        .setPlaceholder("Stats category")
                        .setChannelTypes(ChannelType.GuildCategory)
                        .setMinValues(1)
                        .setMaxValues(1),
                ),
            );
        } else if (state.view === "counters") {
            sections.push(
                "Choose which counters to display. Unselecting a counter removes only its generated channel when stats next update. An empty selection removes all generated counters while enabled.",
            );
            actions.push(
                editorRow(
                    new StringSelectMenuBuilder()
                        .setCustomId(id("counter-select"))
                        .setPlaceholder("Counters to display")
                        .setMinValues(0)
                        .setMaxValues(counterKinds.length)
                        .addOptions(
                            counterKinds.map((kind) => ({
                                label: counterLabel(
                                    kind,
                                    config.separators[kind],
                                ),
                                value: kind,
                                default: config.counters.includes(kind),
                            })),
                        ),
                ),
            );
        } else if (state.view === "separators") {
            sections.push(
                "Choose a counter to edit the separator between its emoji and name. Each counter has its own separator, such as |, ・ or ┃.",
                counterKinds
                    .map((kind) =>
                        escapeMarkdown(
                            counterLabel(kind, config.separators[kind]),
                        ),
                    )
                    .join("\n"),
            );
            const buttons = counterKinds.map((kind) =>
                button(`separator-${kind}`, counterDetails[kind].label),
            );
            actions.push(
                editorRow(...buttons.slice(0, 5)),
                editorRow(...buttons.slice(5)),
            );
        } else if (state.view === "supporters" || state.view === "staff") {
            const roles =
                state.view === "staff"
                    ? config.staff_role_ids
                    : config.supporter_role_ids;
            sections.push(
                "Choose the roles to count. A human with several selected roles counts once. This does not assign or remove anyone's roles.",
            );
            if (state.view === "staff")
                sections.push(
                    "Staff online counts Online, Idle and Do Not Disturb. Invisible members appear offline. The bot needs optional Presence access.",
                );
            actions.push(
                editorRow(
                    new RoleSelectMenuBuilder()
                        .setCustomId(id("role-select"))
                        .setPlaceholder(`Choose ${state.view} roles`)
                        .setMinValues(0)
                        .setMaxValues(25)
                        .setDefaultRoles(roles),
                ),
            );
        } else if (state.view === "preview") {
            sections.push(
                `### Channel preview\n${state.preview?.map((name) => escapeMarkdown(name)).join("\n") ?? "No counters selected."}`,
                "Private preview only. No channels were created or changed.",
            );
        } else {
            sections.push(
                `### Displayed counters\n${config.counters.map((kind) => escapeMarkdown(counterLabel(kind, config.separators[kind]))).join("\n") || "None"}`,
                `**Member goal:** ${config.member_goal ?? "Not set"}\n**Supporter roles:** ${roleList(config.supporter_role_ids)}\n**Staff roles:** ${roleList(config.staff_role_ids)}`,
                "Enable to generate locked voice channels in your category. Counts update about every ten minutes. Apply now creates missing channels and applies changes; existing names respect the same update interval. Pausing keeps channels in place.",
            );
            actions.push(
                editorRow(
                    button("category", "Category"),
                    button("counters", "Counters"),
                    button("supporters", "Supporter roles"),
                    button("staff", "Staff roles"),
                    button("goal", "Member goal"),
                ),
                editorRow(
                    button("separators", "Separators"),
                    button("preview", "Preview"),
                    button(
                        "apply",
                        "Apply now",
                        ButtonStyle.Primary,
                    ).setDisabled(!config.enabled),
                    button(
                        "toggle",
                        config.enabled ? "Pause stats" : "Enable stats",
                        ButtonStyle.Success,
                    ),
                    button("refresh", "Refresh"),
                ),
            );
        }
        if (state.view !== "home")
            actions.push(editorRow(button("home", "Back to settings")));
        return card({
            title: "Server stats editor",
            icon: "📊",
            body: `**Stats:** ${config.enabled ? "Enabled" : "Paused"}\n**Category:** ${config.category_id ? `<#${config.category_id}>` : "Not selected"}`,
            sections,
            actions,
            footer: "Manage Server · Changes apply only to this server",
        });
    }

    protected form(session: Session, action: string) {
        if (session.state.view === "separators") {
            const counter = counterKinds.find(
                (kind) => action === `separator-${kind}`,
            );
            if (counter)
                return {
                    state: { view: "separator-modal" as const, counter },
                    modal: new ModalBuilder()
                        .setTitle(`${counterDetails[counter].label} separator`)
                        .addLabelComponents(
                            editorInput(
                                "Separator",
                                "separator",
                                session.config.separators[counter] ??
                                    defaultCounterSeparator,
                                16,
                                false,
                                "Use a symbol or short text, such as | or ・. Use ┃ for the default.",
                            ),
                        ),
                };
        }
        if (action !== "goal" || session.state.view !== "home")
            return undefined;
        return {
            state: { view: "goal-modal" as const },
            modal: new ModalBuilder()
                .setTitle("Member goal")
                .addLabelComponents(
                    editorInput(
                        "Target member count",
                        "goal",
                        String(session.config.member_goal ?? 1000),
                        10,
                    ),
                ),
        };
    }

    protected async update(
        context: Context,
        session: Session,
        interaction: EditorInteraction,
        action: string,
    ): Promise<EditorChange<State>> {
        const { config, state } = session;
        const saved = (
            patch: Record<string, unknown>,
        ): EditorChange<State> => ({
            state: { view: "home" },
            patch,
            notice: "✓ Saved. Enabled stats apply on their next update. Use Apply now to generate missing channels immediately.",
        });
        if (
            interaction.isChannelSelectMenu() &&
            action === "category-select" &&
            state.view === "category"
        ) {
            const category = await statsCategory(
                interaction.guild,
                interaction.values[0] ?? null,
            );
            return saved({ category_id: category.id });
        }
        if (
            interaction.isStringSelectMenu() &&
            action === "counter-select" &&
            state.view === "counters"
        ) {
            const counters = serverStatsSchema.shape.counters.parse(
                interaction.values,
            );
            return saved({ counters });
        }
        if (
            interaction.isRoleSelectMenu() &&
            action === "role-select" &&
            (state.view === "supporters" || state.view === "staff")
        ) {
            const ids = [...new Set(interaction.values)];
            for (const id of ids) {
                const role = await interaction.guild.roles.fetch(id);
                if (!role || role.id === interaction.guildId)
                    throw new UserError(
                        "Choose existing roles other than @everyone.",
                    );
            }
            return saved({
                [state.view === "staff"
                    ? "staff_role_ids"
                    : "supporter_role_ids"]: ids,
            });
        }
        if (
            interaction.isModalSubmit() &&
            action === "submit" &&
            state.view === "separator-modal" &&
            state.counter
        )
            return saved({
                separators: {
                    [state.counter]: counterSeparatorSchema.parse(
                        interaction.fields.getTextInputValue("separator"),
                    ),
                },
            });
        if (
            interaction.isModalSubmit() &&
            action === "submit" &&
            state.view === "goal-modal"
        )
            return saved({
                member_goal: editorInteger(
                    interaction.fields.getTextInputValue("goal"),
                    "member goal",
                    1,
                    1_000_000_000,
                ),
            });
        if (interaction.isButton()) {
            if (
                [
                    "home",
                    "category",
                    "counters",
                    "separators",
                    "supporters",
                    "staff",
                ].includes(action)
            )
                return { state: { view: action as State["view"] } };
            if (state.view === "home") {
                if (action === "toggle") {
                    if (!config.enabled)
                        await validateStatsSetup(
                            context,
                            interaction.guild,
                            config,
                        );
                    return {
                        patch: { enabled: !config.enabled },
                        notice: config.enabled
                            ? "✓ Stats paused. Existing channels are kept."
                            : "✓ Stats enabled. Use Apply now to generate channels immediately, or wait for the automatic update.",
                    };
                }
                if (action === "preview") {
                    await validateStatsSetup(
                        context,
                        interaction.guild,
                        config,
                    );
                    const counts = await collectStats(
                        context,
                        interaction.guild,
                        config,
                    );
                    return {
                        state: {
                            view: "preview",
                            preview: config.counters.map((kind) =>
                                counterName(
                                    kind,
                                    counts[kind] ?? 0,
                                    config.separators[kind],
                                ),
                            ),
                        },
                    };
                }
                if (action === "apply") {
                    await this.assertCurrent(context, session);
                    return {
                        notice: `✓ ${await this.service.sync(context, interaction.guild, true)}`,
                    };
                }
            }
        }
        throw new UserError(
            "This control is outdated. Refresh the stats editor.",
        );
    }
}
