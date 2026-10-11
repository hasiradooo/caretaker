import {
    ButtonStyle,
    ChannelSelectMenuBuilder,
    ChannelType,
    type GuildMember,
    ModalBuilder,
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
import { type BirthdaySettings, birthdaySchema } from "./config";
import { birthdayCard } from "./presentation";

interface State {
    view: "home" | "channel" | "preview" | "message-modal" | "schedule-modal";
    draft?: string;
}
type Session = EditorSession<BirthdaySettings, State>;

export class BirthdaySettingsEditor extends SettingsEditor<
    BirthdaySettings,
    State
> {
    constructor(now?: () => number) {
        super(
            "birthday",
            birthdaySchema,
            "/birthday settings",
            () => ({ view: "home" }),
            now,
        );
    }

    protected render(session: Session, member: GuildMember, notice?: string) {
        const { config, state } = session;
        const { button, id } = this.controls(session);
        if (state.view === "preview") {
            const preview = birthdayCard(
                { ...config, message: state.draft ?? config.message },
                member,
                true,
            );
            return {
                ...preview,
                components: [
                    ...preview.components,
                    editorRow(
                        ...(state.draft === undefined
                            ? []
                            : [
                                  button(
                                      "save",
                                      "Save message",
                                      ButtonStyle.Success,
                                  ),
                              ]),
                        button(
                            "message",
                            state.draft === undefined
                                ? "Edit message"
                                : "Edit draft",
                        ),
                        button(
                            "home",
                            state.draft === undefined
                                ? "Back to settings"
                                : "Discard draft",
                        ),
                    ),
                ],
            };
        }
        return card({
            title: "Birthday editor",
            icon: "🎂",
            body: `**Celebrations:** ${config.enabled ? "Enabled" : "Paused"}\n**Channel:** ${config.channel_id ? `<#${config.channel_id}>` : "Not selected"}\n**Schedule:** ${String(config.hour).padStart(2, "0")}:00 · ${config.timezone}`,
            sections: [
                ...(notice ? [notice] : []),
                state.view === "channel"
                    ? "Choose where birthdays are celebrated. Channel changes save immediately; they do not enable celebrations."
                    : `### Celebration message\n${clipText(config.message, 400)}\n\nMembers opt in with /birthday set. Birth years are never announced.`,
                !config.channel_id
                    ? "Choose a channel before enabling announcements. Saved birthdays are kept while paused."
                    : "Only the birthday member can be notified. Previews are private and never send a celebration.",
            ],
            actions:
                state.view === "channel"
                    ? [
                          editorRow(
                              new ChannelSelectMenuBuilder()
                                  .setCustomId(id("destination"))
                                  .setPlaceholder(
                                      "Birthday announcement channel",
                                  )
                                  .setChannelTypes(
                                      ChannelType.GuildText,
                                      ChannelType.GuildAnnouncement,
                                  )
                                  .setMinValues(1)
                                  .setMaxValues(1),
                          ),
                          editorRow(
                              button("clear", "Clear channel").setDisabled(
                                  !config.channel_id,
                              ),
                              button("home", "Back to settings"),
                          ),
                      ]
                    : [
                          editorRow(
                              button("channel", "Channel"),
                              button(
                                  "message",
                                  "Edit message",
                                  ButtonStyle.Primary,
                              ),
                              button("schedule", "Time zone & hour"),
                              button("preview", "Preview"),
                          ),
                          editorRow(
                              button(
                                  "toggle",
                                  config.enabled
                                      ? "Pause birthdays"
                                      : "Enable birthdays",
                              ),
                              button("refresh", "Refresh"),
                          ),
                      ],
            footer: "Manage Server · Changes apply only to this server",
        });
    }

    protected form(session: Session, action: string) {
        if (
            action === "message" &&
            ["home", "preview"].includes(session.state.view)
        )
            return {
                state: { ...session.state, view: "message-modal" as const },
                modal: new ModalBuilder()
                    .setTitle("Birthday message")
                    .addLabelComponents(
                        editorInput(
                            "Celebration message",
                            "message",
                            session.state.draft ?? session.config.message,
                            1800,
                            true,
                            "{user}, {display_name}, {server}; link channels with <#ID>",
                        ),
                    ),
            };
        if (action === "schedule" && session.state.view === "home")
            return {
                state: { view: "schedule-modal" as const },
                modal: new ModalBuilder()
                    .setTitle("Birthday schedule")
                    .addLabelComponents(
                        editorInput(
                            "Time zone",
                            "timezone",
                            session.config.timezone,
                            100,
                            false,
                            "For example Europe/Warsaw; daylight saving adjusts automatically",
                        ),
                        editorInput(
                            "Announcement hour (0–23)",
                            "hour",
                            String(session.config.hour),
                            2,
                            false,
                            "Local hour in the time zone above",
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
            if (state.view === "message-modal") {
                const message = interaction.fields
                    .getTextInputValue("message")
                    .trim();
                if (!message || message.length > 1800)
                    throw new UserError(
                        "Enter a message between 1 and 1,800 characters.",
                    );
                return { state: { view: "preview", draft: message } };
            }
            if (state.view === "schedule-modal") {
                const timezone = interaction.fields
                    .getTextInputValue("timezone")
                    .trim();
                const hour = editorInteger(
                    interaction.fields.getTextInputValue("hour"),
                    "hour",
                    0,
                    23,
                );
                birthdaySchema.parse({ ...config, timezone, hour });
                return {
                    state: { view: "home" },
                    patch: { timezone, hour },
                    notice: "✓ Birthday schedule saved.",
                };
            }
        }
        if (
            interaction.isChannelSelectMenu() &&
            action === "destination" &&
            state.view === "channel"
        ) {
            const channel = await sendableChannel(
                interaction.guild,
                interaction.values[0] ?? "",
            );
            if (
                ![
                    ChannelType.GuildText,
                    ChannelType.GuildAnnouncement,
                ].includes(channel.type)
            )
                throw new UserError("Choose a text or announcement channel.");
            return {
                patch: { channel_id: channel.id },
                notice: "✓ Birthday channel saved.",
            };
        }
        if (interaction.isButton()) {
            if (action === "home") return { state: { view: "home" } };
            if (
                action === "save" &&
                state.view === "preview" &&
                state.draft !== undefined
            )
                return {
                    patch: { message: state.draft },
                    state: { view: "home" },
                    notice: "✓ Birthday message saved.",
                };
            if (action === "clear" && state.view === "channel")
                return {
                    patch: { channel_id: null },
                    notice: "✓ Birthday announcements have no destination. Saved dates are kept.",
                };
            if (state.view === "home") {
                if (action === "channel" || action === "preview")
                    return { state: { view: action } };
                if (action === "toggle") {
                    if (!config.enabled) {
                        if (!config.channel_id)
                            throw new UserError(
                                "Choose a birthday channel before enabling celebrations.",
                            );
                        await sendableChannel(
                            interaction.guild,
                            config.channel_id,
                        );
                    }
                    return {
                        patch: { enabled: !config.enabled },
                        notice: config.enabled
                            ? "✓ Birthdays paused. Saved dates are kept."
                            : "✓ Birthday celebrations enabled.",
                    };
                }
            }
        }
        throw new UserError(
            "This control is outdated. Refresh the birthday editor.",
        );
    }
}
