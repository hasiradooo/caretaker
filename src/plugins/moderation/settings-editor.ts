import {
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    type GuildMember,
    LabelBuilder,
    ModalBuilder,
    PermissionFlagsBits,
    RoleSelectMenuBuilder,
    StringSelectMenuBuilder,
    TextInputBuilder,
    TextInputStyle,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { sendableChannel } from "../../shared/discord";
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
    MAX_RULES,
    type ModerationRule,
    type ModerationSettings,
    moderationSchema,
    ruleSchema,
} from "./config";
import { actionNames, conditionNames, eventNames } from "./rules";

type View =
    | "home"
    | "rule"
    | "choice"
    | "scope"
    | "exceptions"
    | "logs"
    | "new-form"
    | "details-form";
interface State {
    view: View;
    ruleId?: string;
    choice?: "event" | "condition" | "action";
}
type Session = EditorSession<ModerationSettings, State>;
const channelTypes = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
];
const optionalInput = (value: string) =>
    new LabelBuilder()
        .setLabel("Words / domains (one per line; blank clears)")
        .setTextInputComponent(
            new TextInputBuilder()
                .setCustomId("values")
                .setValue(value)
                .setRequired(false)
                .setMaxLength(4000)
                .setStyle(TextInputStyle.Paragraph),
        );
const selectedRule = (session: Session) => {
    const rule = session.config.rules.find(
        (item) => item.id === session.state.ruleId,
    );
    if (!rule)
        throw new UserError("This rule no longer exists. Refresh the editor.");
    return rule;
};
const list = (ids: string[], role = false) =>
    ids.length
        ? clipText(
              ids.map((id) => (role ? `<@&${id}>` : `<#${id}>`)).join(", "),
              700,
          )
        : "All";

export class ModerationSettingsEditor extends SettingsEditor<
    ModerationSettings,
    State
> {
    constructor(now?: () => number) {
        super(
            "moderation",
            moderationSchema,
            "/moderation settings",
            () => ({ view: "home" }),
            now,
        );
    }
    protected render(session: Session, _member: GuildMember, notice?: string) {
        const { config, state } = session;
        const { id, button } = this.controls(session);
        const sections = notice ? [notice] : [];
        const actions = [];
        let title = "Automatic moderation";
        let body = `**Status:** ${config.enabled ? "Enabled" : "Paused"}\n**Rules:** ${config.rules.length}/${MAX_RULES}\n**Log channel:** ${config.log_channel_id ? `<#${config.log_channel_id}>` : "Not set"}`;
        if (["rule", "choice", "scope"].includes(state.view)) {
            const rule = selectedRule(session);
            title = "Moderation rule";
            body = `**${clipText(rule.name.replace(/[\r\n`*_<>]/g, ""), 60)}** · ${rule.enabled ? "On" : "Off"}\n**When:** ${eventNames[rule.event]}\n**If:** ${conditionNames[rule.condition]}\n**Then:** ${actionNames[rule.action]}${rule.action === "delete_timeout" ? ` (${rule.timeout_minutes} min)` : ""}`;
            sections.push(
                `Rule ID: ${rule.id}\n**Channels:** ${list(rule.channels)}\n**Member roles:** ${list(rule.roles, true)}\n${rule.condition === "mentions" ? `Mention limit: ${rule.mention_limit} (everyone/here also matches).` : rule.condition === "words" || rule.condition === "domains" ? `${rule.values.length} matching entries. Use Details to edit them.` : ""}`,
            );
            if (state.view === "choice" && state.choice) {
                const names =
                    state.choice === "event"
                        ? eventNames
                        : state.choice === "condition"
                          ? conditionNames
                          : actionNames;
                actions.push(
                    editorRow(
                        new StringSelectMenuBuilder()
                            .setCustomId(id("choose"))
                            .setPlaceholder(`Choose ${state.choice}`)
                            .addOptions(
                                Object.entries(names).map(([value, label]) => ({
                                    label,
                                    value,
                                    default:
                                        rule[
                                            state.choice as
                                                | "event"
                                                | "condition"
                                                | "action"
                                        ] === value,
                                })),
                            ),
                    ),
                    editorRow(button("rule", "Back to rule")),
                );
            } else if (state.view === "scope") {
                sections.push(
                    "Choose up to 25 channels and roles. Empty selection means all. Selecting a parent channel includes its threads. Roles match when the member has any selected role. Global exceptions still apply.",
                );
                actions.push(
                    editorRow(
                        new ChannelSelectMenuBuilder()
                            .setCustomId(id("rule-channels"))
                            .setPlaceholder(
                                "Replace channel scope (empty = all)",
                            )
                            .setChannelTypes(...channelTypes)
                            .setMinValues(0)
                            .setMaxValues(25),
                    ),
                    editorRow(
                        new RoleSelectMenuBuilder()
                            .setCustomId(id("rule-roles"))
                            .setPlaceholder("Replace role scope (empty = all)")
                            .setMinValues(0)
                            .setMaxValues(25),
                    ),
                    editorRow(button("rule", "Back to rule")),
                );
            } else {
                sections.push(
                    "Choose When, Condition and Action independently. New rules are off until you enable them. Words match case-insensitive substrings; domains match the exact host and its subdomains.",
                );
                actions.push(
                    editorRow(
                        button("event", "When"),
                        button("condition", "Condition"),
                        button("action", "Action"),
                        button("details", "Details"),
                        button("scope", "Channels & roles"),
                    ),
                    editorRow(
                        button(
                            "rule-toggle",
                            rule.enabled ? "Disable rule" : "Enable rule",
                            ButtonStyle.Primary,
                        ),
                        button("remove", "Remove rule", ButtonStyle.Danger),
                        button("home", "All rules"),
                        button("refresh", "Refresh"),
                    ),
                );
            }
        } else if (state.view === "exceptions") {
            sections.push(
                `**Exempt roles:** ${config.exempt_roles.length ? list(config.exempt_roles, true) : "None"}\n**Exempt channels:** ${config.exempt_channels.length ? list(config.exempt_channels) : "None"}\nStaff exemption covers Administrator, Manage Server and Manage Messages. The server owner and Caretaker are always exempt. Bot/webhook moderation is a separate opt-in.`,
            );
            actions.push(
                editorRow(
                    new RoleSelectMenuBuilder()
                        .setCustomId(id("exempt-roles"))
                        .setPlaceholder("Replace exempt roles (empty = none)")
                        .setMinValues(0)
                        .setMaxValues(25),
                ),
                editorRow(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(id("exempt-channels"))
                        .setPlaceholder(
                            "Replace exempt channels (empty = none)",
                        )
                        .setChannelTypes(...channelTypes)
                        .setMinValues(0)
                        .setMaxValues(25),
                ),
                editorRow(
                    button(
                        "staff",
                        config.exempt_staff
                            ? "Also check staff"
                            : "Exempt staff",
                    ),
                    button(
                        "bots",
                        config.include_bots
                            ? "Ignore bots/webhooks"
                            : "Check bots/webhooks",
                    ),
                    button("home", "Back"),
                ),
            );
        } else if (state.view === "logs") {
            sections.push(
                "Logs include member/message IDs, matched rule IDs and outcomes. Removed text and media are never copied into the log. Choose a staff channel.",
            );
            actions.push(
                editorRow(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(id("log-channel"))
                        .setPlaceholder("Choose moderation log channel")
                        .setChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement,
                        )
                        .setMinValues(1)
                        .setMaxValues(1),
                ),
                editorRow(
                    button("clear-log", "Clear log channel"),
                    button("home", "Back"),
                ),
            );
        } else {
            sections.push(
                "Build a rule as **When → Condition → Action**. Example: **Message edited → Contains a link → Delete message**. Old and uncached messages are checked when edited while the bot is online; no history scan is needed.",
            );
            if (config.rules.length)
                actions.push(
                    editorRow(
                        new StringSelectMenuBuilder()
                            .setCustomId(id("select-rule"))
                            .setPlaceholder("Choose a rule to edit")
                            .addOptions(
                                config.rules.map((rule) => ({
                                    label: clipText(rule.name, 80),
                                    value: rule.id,
                                    description: `${rule.enabled ? "On" : "Off"} · ${eventNames[rule.event]} · ${conditionNames[rule.condition]}`,
                                })),
                            ),
                    ),
                );
            actions.push(
                editorRow(
                    button("new", "Add rule", ButtonStyle.Primary).setDisabled(
                        config.rules.length >= MAX_RULES,
                    ),
                    button("exceptions", "Exceptions"),
                    button("logs", "Logs"),
                ),
                editorRow(
                    button(
                        "toggle",
                        config.enabled
                            ? "Pause moderation"
                            : "Enable moderation",
                    ),
                    button("refresh", "Refresh"),
                ),
            );
        }
        return card({
            title,
            icon: "🛡️",
            body,
            sections,
            actions,
            footer: "Manage Server · Changes save to this server only",
        });
    }
    protected form(session: Session, action: string) {
        if (action === "new" && session.state.view === "home")
            return {
                state: { view: "new-form" as const },
                modal: new ModalBuilder()
                    .setTitle("Create moderation rule")
                    .addLabelComponents(
                        editorInput(
                            "Rule name",
                            "name",
                            "Block links in edited messages",
                            60,
                        ),
                    ),
            };
        if (action === "details" && session.state.view === "rule") {
            const rule = selectedRule(session);
            return {
                state: { ...session.state, view: "details-form" as const },
                modal: new ModalBuilder()
                    .setTitle("Rule details")
                    .addLabelComponents(
                        editorInput("Rule name", "name", rule.name, 60),
                        optionalInput(rule.values.join("\n")),
                        editorInput(
                            "Mention limit (mentions condition)",
                            "limit",
                            String(rule.mention_limit),
                            3,
                        ),
                        editorInput(
                            "Timeout minutes (delete + timeout)",
                            "timeout",
                            String(rule.timeout_minutes),
                            5,
                        ),
                    ),
            };
        }
        return undefined;
    }
    protected async update(
        _context: Context,
        session: Session,
        interaction: EditorInteraction,
        action: string,
    ): Promise<EditorChange<State>> {
        const { state, config } = session;
        const checkTimeoutPermission = async (rules: ModerationRule[]) => {
            if (
                !rules.some(
                    (rule) => rule.enabled && rule.action === "delete_timeout",
                )
            )
                return;
            const me =
                interaction.guild.members.me ??
                (await interaction.guild.members.fetchMe());
            if (!me.permissions.has(PermissionFlagsBits.ModerateMembers))
                throw new UserError(
                    "Give Caretaker Moderate Members before activating a timeout rule.",
                );
        };
        const changeRule = async (
            patch: Partial<ModerationRule>,
        ): Promise<EditorChange<State>> => {
            const rule = ruleSchema.parse({
                ...selectedRule(session),
                ...patch,
            });
            if (config.enabled) await checkTimeoutPermission([rule]);
            return {
                patch: {
                    rules: config.rules.map((item) =>
                        item.id === rule.id ? rule : item,
                    ),
                },
                state: { view: "rule", ruleId: rule.id },
                notice: "✓ Rule saved.",
            };
        };
        if (interaction.isModalSubmit() && action === "submit") {
            if (state.view === "new-form") {
                if (config.rules.length >= MAX_RULES)
                    throw new UserError(
                        `Maximum ${MAX_RULES} rules. Remove one first.`,
                    );
                const rule = ruleSchema.parse({
                    id: crypto.randomUUID(),
                    name: interaction.fields.getTextInputValue("name"),
                });
                return {
                    patch: { rules: [...config.rules, rule] },
                    state: { view: "rule", ruleId: rule.id },
                    notice: "✓ Rule created, currently disabled. Configure it and then enable it.",
                };
            }
            if (state.view === "details-form")
                return changeRule({
                    name: interaction.fields.getTextInputValue("name"),
                    values: [
                        ...new Set(
                            interaction.fields
                                .getTextInputValue("values")
                                .split(/\r?\n/)
                                .map((value) => value.trim())
                                .filter(Boolean),
                        ),
                    ],
                    mention_limit: editorInteger(
                        interaction.fields.getTextInputValue("limit"),
                        "mention limit",
                        1,
                        100,
                    ),
                    timeout_minutes: editorInteger(
                        interaction.fields.getTextInputValue("timeout"),
                        "timeout minutes",
                        1,
                        40320,
                    ),
                });
        }
        if (interaction.isStringSelectMenu()) {
            if (
                action === "select-rule" &&
                state.view === "home" &&
                config.rules.some((rule) => rule.id === interaction.values[0])
            )
                return {
                    state: { view: "rule", ruleId: interaction.values[0] },
                };
            if (
                action === "choose" &&
                state.view === "choice" &&
                state.choice
            ) {
                // Changing the condition pauses the rule so incomplete edits cannot delete messages.
                return changeRule({
                    [state.choice]: interaction.values[0],
                    ...(state.choice === "condition"
                        ? { enabled: false, values: [] }
                        : {}),
                });
            }
        }
        if (interaction.isChannelSelectMenu()) {
            const ids = [...new Set(interaction.values)];
            if (ids.length > 25)
                throw new UserError("Choose at most 25 channels.");
            for (const channelId of ids) {
                const channel =
                    await interaction.guild.channels.fetch(channelId);
                if (!channel || !channelTypes.includes(channel.type))
                    throw new UserError(
                        "Choose text, announcement or forum channels from this server.",
                    );
            }
            if (action === "log-channel" && state.view === "logs") {
                if (ids.length !== 1)
                    throw new UserError("Choose one log channel.");
                const channel = await sendableChannel(
                    interaction.guild,
                    ids[0] ?? "",
                );
                return {
                    patch: { log_channel_id: channel.id },
                    notice: "✓ Log channel saved.",
                };
            }
            if (action === "rule-channels" && state.view === "scope")
                return changeRule({ channels: ids });
            if (action === "exempt-channels" && state.view === "exceptions")
                return {
                    patch: { exempt_channels: ids },
                    notice: "✓ Channel exceptions saved.",
                };
        }
        if (interaction.isRoleSelectMenu()) {
            const ids = [...new Set(interaction.values)];
            if (ids.length > 25)
                throw new UserError("Choose at most 25 roles.");
            for (const role of ids)
                if (
                    role === interaction.guildId ||
                    !(await interaction.guild.roles.fetch(role))
                )
                    throw new UserError(
                        "Choose server roles other than @everyone.",
                    );
            if (action === "rule-roles" && state.view === "scope")
                return changeRule({ roles: ids });
            if (action === "exempt-roles" && state.view === "exceptions")
                return {
                    patch: { exempt_roles: ids },
                    notice: "✓ Role exceptions saved.",
                };
        }
        if (interaction.isButton()) {
            if (action === "home") return { state: { view: "home" } };
            if (["rule", "scope"].includes(action) && state.ruleId)
                return {
                    state: {
                        view: action as "rule" | "scope",
                        ruleId: selectedRule(session).id,
                    },
                };
            if (state.view === "rule") {
                if (
                    action === "event" ||
                    action === "condition" ||
                    action === "action"
                )
                    return {
                        state: { ...state, view: "choice", choice: action },
                    };
                if (action === "rule-toggle")
                    return changeRule({
                        enabled: !selectedRule(session).enabled,
                    });
                if (action === "remove")
                    return {
                        patch: {
                            rules: config.rules.filter(
                                (rule) => rule.id !== selectedRule(session).id,
                            ),
                        },
                        state: { view: "home" },
                        notice: "✓ Rule removed.",
                    };
            }
            if (state.view === "home") {
                if (action === "exceptions" || action === "logs")
                    return { state: { view: action } };
                if (action === "toggle") {
                    // Manage Messages is channel-specific and checked again at deletion.
                    // A server may grant it only in watched channels, or use log-only rules.
                    if (!config.enabled)
                        await checkTimeoutPermission(config.rules);
                    return {
                        patch: { enabled: !config.enabled },
                        notice: config.enabled
                            ? "✓ Moderation paused."
                            : "✓ Moderation enabled. Give Caretaker View Channel, Read Message History and (for deletion) Manage Messages in watched channels. Only enabled rules take action.",
                    };
                }
            }
            if (state.view === "exceptions" && action === "staff")
                return { patch: { exempt_staff: !config.exempt_staff } };
            if (state.view === "exceptions" && action === "bots")
                return { patch: { include_bots: !config.include_bots } };
            if (state.view === "logs" && action === "clear-log")
                return {
                    patch: { log_channel_id: null },
                    notice: "✓ Log channel cleared.",
                };
        }
        throw new UserError(
            "This control is outdated. Refresh the moderation editor.",
        );
    }
}
