import {
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    type GuildMember,
    ModalBuilder,
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
import { type StarboardSettings, starboardSchema } from "./config";
import { starboardCard, starboardSummary } from "./presentation";
import {
    sourceChannelTypes,
    starboardDestination,
    starboardEmoji,
    starboardSource,
    validateStarboardSetup,
} from "./setup";

interface State {
    view:
        | "home"
        | "channel"
        | "watch"
        | "preview"
        | "threshold-modal"
        | "emoji-modal";
    mode?: "add" | "remove";
    page?: number;
}
type Session = EditorSession<StarboardSettings, State>;

export class StarboardSettingsEditor extends SettingsEditor<
    StarboardSettings,
    State
> {
    constructor(now?: () => number) {
        super(
            "starboard",
            starboardSchema,
            "/starboard settings",
            () => ({ view: "home" }),
            now,
        );
    }

    protected render(session: Session, member: GuildMember, notice?: string) {
        const { config, state } = session;
        const { button, id } = this.controls(session);
        if (state.view === "preview") {
            const preview = starboardCard({
                authorId: member.id,
                avatar: member.displayAvatarURL(),
                channelId: config.watch_channels?.[0],
                emoji: config.emoji,
                count: config.threshold,
                createdAt: Date.now(),
                text: "A message your community enjoyed, with four sample photos. The last photo is a spoiler. ||Example spoiler text.||",
                images: Array.from({ length: 4 }, (_, index) => ({
                    url: member.displayAvatarURL({ size: 1024 }),
                    spoiler: index === 3,
                })),
                preview: true,
            });
            return {
                ...preview,
                components: [
                    ...preview.components,
                    editorRow(button("home", "Back to settings")),
                ],
            };
        }
        const sections = notice ? [notice] : [];
        const actions = [];
        if (state.view === "channel") {
            sections.push(
                "Choose where new highlights appear. Existing highlights keep their original destination. Selecting a channel saves it without enabling starboard.",
            );
            actions.push(
                editorRow(
                    new ChannelSelectMenuBuilder()
                        .setCustomId(id("destination"))
                        .setPlaceholder("Starboard destination")
                        .setChannelTypes(
                            ChannelType.GuildText,
                            ChannelType.GuildAnnouncement,
                        )
                        .setMinValues(1)
                        .setMaxValues(1),
                ),
                editorRow(
                    button("clear", "Clear channel & pause").setDisabled(
                        !config.channel_id,
                    ),
                    button("home", "Back to settings"),
                ),
            );
        } else if (state.view === "watch") {
            const selected = config.watch_channels ?? [];
            const page = Math.min(
                state.page ?? 0,
                Math.max(0, Math.ceil(selected.length / 25) - 1),
            );
            const slice = selected.slice(page * 25, (page + 1) * 25);
            sections.push(
                config.watch_channels === null
                    ? "All eligible public and private channels the bot can read are watched. Adding a selection switches to watching only those channels."
                    : `**Selected channels**\n${clipText(selected.map((channel) => `<#${channel}>`).join(", ") || "None", 1800)}`,
                "Public threads in selected channels are included. Private threads and the starboard destination are excluded. Highlights from private channels appear in the starboard destination too.",
            );
            actions.push(
                editorRow(
                    button("home", "Back"),
                    button("all", "All accessible channels"),
                    button("none", "Watch none"),
                    button("add", "Add channels").setDisabled(
                        state.mode !== "remove",
                    ),
                    button("remove", "Remove channels").setDisabled(
                        state.mode === "remove" || selected.length === 0,
                    ),
                ),
            );
            if (state.mode === "remove" && slice.length) {
                actions.push(
                    editorRow(
                        new StringSelectMenuBuilder()
                            .setCustomId(id("remove-channels"))
                            .setPlaceholder("Select watched channels to remove")
                            .setMinValues(1)
                            .setMaxValues(slice.length)
                            .addOptions(
                                slice.map((channel) => ({
                                    label: clipText(
                                        member.guild.channels.cache.get(channel)
                                            ?.name ?? channel,
                                        100,
                                    ),
                                    value: channel,
                                })),
                            ),
                    ),
                );
                if (selected.length > 25)
                    actions.push(
                        editorRow(
                            button("previous", "Previous").setDisabled(
                                page === 0,
                            ),
                            button(
                                "next",
                                `Next (${page + 1}/${Math.ceil(selected.length / 25)})`,
                            ).setDisabled((page + 1) * 25 >= selected.length),
                        ),
                    );
            } else {
                actions.push(
                    editorRow(
                        new ChannelSelectMenuBuilder()
                            .setCustomId(id("add-channels"))
                            .setPlaceholder("Add up to 25 channels")
                            .setChannelTypes(...sourceChannelTypes)
                            .setMinValues(1)
                            .setMaxValues(25),
                    ),
                );
            }
        } else {
            if (!config.channel_id)
                sections.push(
                    "Choose a destination channel first. Highlights cannot be posted until one is selected.",
                );
            sections.push(
                "Messages from watched public and private channels the bot can read appear in the destination when they reach the reaction threshold. Editing settings does not scan old messages or move existing highlights; eligible reactions apply the current rules.",
                "Auto-reactions add the selected emoji to new member posts in watched channels while starboard is enabled. The bot's reaction never counts toward the threshold. Requires Add Reactions and Read Message History in those channels.",
            );
            actions.push(
                editorRow(
                    button("channel", "Channel"),
                    button(
                        "threshold",
                        "Reaction threshold",
                        ButtonStyle.Primary,
                    ),
                    button("emoji", "Emoji"),
                    button("watch", "Watched channels"),
                    button(
                        "auto-react",
                        config.auto_react
                            ? "Disable auto-reactions"
                            : "Enable auto-reactions",
                    ),
                ),
                editorRow(
                    button(
                        "self",
                        config.allow_self_star
                            ? "Ignore self-stars"
                            : "Count self-stars",
                    ),
                    button("preview", "Preview"),
                    button(
                        "toggle",
                        config.enabled ? "Pause starboard" : "Enable starboard",
                    ),
                    button("refresh", "Refresh"),
                ),
            );
        }
        return card({
            title: "Starboard editor",
            icon: "⭐",
            body: starboardSummary(config),
            sections,
            actions,
            footer: "Manage Server · Changes apply only to this server",
        });
    }

    protected form(session: Session, action: string) {
        if (session.state.view !== "home") return undefined;
        if (action === "threshold")
            return {
                state: { view: "threshold-modal" as const },
                modal: new ModalBuilder()
                    .setTitle("Starboard threshold")
                    .addLabelComponents(
                        editorInput(
                            "Required reactions (1–1000)",
                            "threshold",
                            String(session.config.threshold),
                            4,
                        ),
                    ),
            };
        if (action === "emoji")
            return {
                state: { view: "emoji-modal" as const },
                modal: new ModalBuilder()
                    .setTitle("Starboard emoji")
                    .addLabelComponents(
                        editorInput(
                            "Reaction emoji",
                            "emoji",
                            session.config.emoji,
                            100,
                            false,
                            "Paste one emoji, or a custom emoji from this server (or its ID)",
                        ),
                    ),
            };
        return undefined;
    }

    protected async update(
        _context: Context,
        session: Session,
        interaction: EditorInteraction,
        action: string,
    ): Promise<EditorChange<State>> {
        const { config, state } = session;
        if (interaction.isModalSubmit() && action === "submit") {
            if (state.view === "threshold-modal")
                return {
                    state: { view: "home" },
                    patch: {
                        threshold: editorInteger(
                            interaction.fields.getTextInputValue("threshold"),
                            "reaction count",
                            1,
                            1000,
                        ),
                    },
                    notice: "✓ Reaction threshold saved.",
                };
            if (state.view === "emoji-modal")
                return {
                    state: { view: "home" },
                    patch: {
                        emoji: await starboardEmoji(
                            interaction.guild,
                            interaction.fields.getTextInputValue("emoji"),
                        ),
                    },
                    notice: "✓ Reaction emoji saved.",
                };
        }
        if (interaction.isChannelSelectMenu()) {
            if (action === "destination" && state.view === "channel") {
                const channel = await starboardDestination(
                    interaction.guild,
                    interaction.values[0] ?? "",
                );
                return {
                    patch: {
                        channel_id: channel.id,
                        ...(config.watch_channels?.includes(channel.id)
                            ? {
                                  watch_channels: config.watch_channels.filter(
                                      (value) => value !== channel.id,
                                  ),
                              }
                            : {}),
                    },
                    notice: "✓ Destination saved. It is excluded from watched channels.",
                };
            }
            if (
                action === "add-channels" &&
                state.view === "watch" &&
                state.mode !== "remove"
            ) {
                const selected = [...new Set(interaction.values)];
                if (!selected.length || selected.length > 25)
                    throw new UserError("Choose between 1 and 25 channels.");
                const channels = [
                    ...new Set([...(config.watch_channels ?? []), ...selected]),
                ];
                if (channels.length > 100)
                    throw new UserError(
                        "You can watch up to 100 selected channels. Remove some first or choose All accessible channels.",
                    );
                for (const channel of selected)
                    await starboardSource(
                        interaction.guild,
                        channel,
                        config.channel_id,
                    );
                return {
                    patch: { watch_channels: channels },
                    notice: "✓ Watched channels saved.",
                };
            }
        }
        if (
            interaction.isStringSelectMenu() &&
            action === "remove-channels" &&
            state.view === "watch" &&
            state.mode === "remove"
        ) {
            const selected = config.watch_channels ?? [];
            const page = Math.min(
                state.page ?? 0,
                Math.max(0, Math.ceil(selected.length / 25) - 1),
            );
            const visible = selected.slice(page * 25, (page + 1) * 25);
            if (
                !interaction.values.length ||
                interaction.values.some((value) => !visible.includes(value))
            )
                throw new UserError("Choose channels from the displayed list.");
            const remaining = selected.filter(
                (value) => !interaction.values.includes(value),
            );
            return {
                patch: { watch_channels: remaining },
                state: {
                    view: "watch",
                    mode: remaining.length ? "remove" : "add",
                    page: 0,
                },
                notice: "✓ Channels removed. Existing highlights are kept.",
            };
        }
        if (interaction.isButton()) {
            if (action === "home") return { state: { view: "home" } };
            if (action === "clear" && state.view === "channel")
                return {
                    patch: { channel_id: null, enabled: false },
                    notice: "✓ Destination cleared and starboard paused. Existing highlights are kept.",
                };
            if (state.view === "home") {
                if (
                    action === "channel" ||
                    action === "watch" ||
                    action === "preview"
                )
                    return { state: { view: action } };
                if (action === "self")
                    return {
                        patch: { allow_self_star: !config.allow_self_star },
                        notice: "✓ Self-star rule saved.",
                    };
                if (action === "auto-react")
                    return {
                        patch: { auto_react: !config.auto_react },
                        notice: config.auto_react
                            ? "✓ Auto-reactions disabled. Existing reactions are kept."
                            : "✓ Auto-reactions enabled for new posts while starboard is active. Older posts are unchanged.",
                    };
                if (action === "toggle") {
                    if (!config.enabled)
                        await validateStarboardSetup(interaction.guild, config);
                    return {
                        patch: { enabled: !config.enabled },
                        notice: config.enabled
                            ? "✓ Starboard paused. Existing highlights are kept."
                            : "✓ Starboard enabled.",
                    };
                }
            }
            if (state.view === "watch") {
                if (action === "all" || action === "none")
                    return {
                        patch: { watch_channels: action === "all" ? null : [] },
                        state: { view: "watch" },
                        notice:
                            action === "all"
                                ? "✓ Watching all accessible public and private channels."
                                : "✓ Watching no channels. Existing highlights are kept.",
                    };
                if (action === "add" || action === "remove")
                    return { state: { view: "watch", mode: action, page: 0 } };
                if (
                    state.mode === "remove" &&
                    (action === "previous" || action === "next")
                )
                    return {
                        state: {
                            ...state,
                            page: Math.max(
                                0,
                                (state.page ?? 0) +
                                    (action === "next" ? 1 : -1),
                            ),
                        },
                    };
            }
        }
        throw new UserError(
            "This control is outdated. Refresh the starboard editor.",
        );
    }
}
