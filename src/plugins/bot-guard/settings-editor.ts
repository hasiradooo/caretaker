import {
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
import type { z } from "zod";
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
import { roleIds } from "../../shared/validation";
import { botGuardSchema } from "./config";

type Config = z.infer<typeof botGuardSchema>;
interface State {
  view: "home" | "roles" | "logs" | "allow-form" | "options-form";
}
type Session = EditorSession<Config, State>;
export class BotGuardSettingsEditor extends SettingsEditor<Config, State> {
  constructor(now?: () => number) {
    super(
      "auto_ban_bots",
      botGuardSchema,
      "/botguard settings",
      () => ({ view: "home" }),
      now,
    );
  }
  protected render(session: Session, _member: GuildMember, notice?: string) {
    const { config, state } = session;
    const { id, button } = this.controls(session);
    const sections = notice ? [notice] : [];
    const actions = [];
    sections.push(
      `**Allowed account IDs:** ${clipText(config.allowed_bot_ids.join(", ") || "None", 900)}\n**Quarantine roles:** ${clipText(config.watch_roles.map((role) => `<@&${role}>`).join(", ") || "None", 900)}\n**Log channel:** ${config.log_channel_id ? `<#${config.log_channel_id}>` : "Not set"}`,
    );
    if (state.view === "roles") {
      sections.push(
        "Accounts in the chosen scope are banned when they have any selected role. Role changes are checked immediately; periodic checks also find uncached members. The interval is a scan frequency, not a delay before banning. Allowed accounts, the server owner and Caretaker are exempt. @everyone is ignored; empty roles turn off quarantine checks.",
      );
      actions.push(
        editorRow(
          new RoleSelectMenuBuilder()
            .setCustomId(id("roles"))
            .setPlaceholder("Replace quarantine roles (empty = none)")
            .setMinValues(0)
            .setMaxValues(25),
        ),
        editorRow(
          new StringSelectMenuBuilder()
            .setCustomId(id("targets"))
            .setPlaceholder("Who should quarantine roles ban?")
            .addOptions(
              {
                label: "Bot accounts only",
                value: "bots",
                default: config.quarantine_targets === "bots",
              },
              {
                label: "All accounts (members and bots)",
                value: "all",
                default: config.quarantine_targets === "all",
              },
            ),
        ),
        editorRow(button("home", "Back")),
      );
    } else if (state.view === "logs") {
      actions.push(
        editorRow(
          new ChannelSelectMenuBuilder()
            .setCustomId(id("log"))
            .setPlaceholder("Choose a staff log channel")
            .setChannelTypes(
              ChannelType.GuildText,
              ChannelType.GuildAnnouncement,
            )
            .setMinValues(1)
            .setMaxValues(1),
        ),
        editorRow(button("clear-log", "Clear logs"), button("home", "Back")),
      );
    } else {
      sections.push(
        "Join protection bans future unapproved bot joins only. Quarantine roles can target bots or all accounts—choose the scope under Quarantine roles. Allowed accounts, the server owner and Caretaker are exempt.",
        `**History removal:** ${config.delete_message_days} day(s)\n**Periodic scan interval:** ${config.ban_check_interval_minutes} minutes\nRole changes are checked immediately; the interval is not a ban delay.`,
      );
      actions.push(
        editorRow(
          button("allow", "Allowed accounts"),
          button("quarantine", "Quarantine roles"),
          button("logs", "Logs"),
          button("options", "Options"),
        ),
        editorRow(
          button(
            "join",
            config.ban_on_join
              ? "Turn join bans off"
              : "Ban unapproved bot joins",
          ),
          button(
            "toggle",
            config.enabled ? "Pause bot guard" : "Enable bot guard",
          ),
          button("refresh", "Refresh"),
        ),
      );
    }
    return card({
      title: "Bot guard",
      icon: "🛡️",
      body: `**Status:** ${config.enabled ? "Enabled" : "Paused"}\n**Ban unapproved bots on join:** ${config.ban_on_join ? "On" : "Off"}\n**Quarantine applies to:** ${config.quarantine_targets === "all" ? "All accounts (members and bots)" : "Bot accounts only"}`,
      sections,
      actions,
      footer: "Manage Server · Ban Members and role hierarchy required",
    });
  }
  protected form(session: Session, action: string) {
    if (session.state.view !== "home") return undefined;
    if (action === "allow")
      return {
        state: { view: "allow-form" as const },
        modal: new ModalBuilder()
          .setTitle("Allowed account IDs")
          .addLabelComponents(
            new LabelBuilder()
              .setLabel("Account IDs, one per line (blank clears)")
              .setDescription("These accounts are exempt from automatic bans.")
              .setTextInputComponent(
                new TextInputBuilder()
                  .setCustomId("ids")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(false)
                  .setMaxLength(2200)
                  .setValue(session.config.allowed_bot_ids.join("\n")),
              ),
          ),
      };
    if (action === "options")
      return {
        state: { view: "options-form" as const },
        modal: new ModalBuilder()
          .setTitle("Bot guard options")
          .addLabelComponents(
            editorInput(
              "Days of messages to delete after ban (0–7)",
              "days",
              String(session.config.delete_message_days),
              1,
            ),
            editorInput(
              "Periodic scan interval in minutes",
              "interval",
              String(session.config.ban_check_interval_minutes),
              4,
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
    const { state, config } = session;
    if (interaction.isModalSubmit() && action === "submit") {
      if (state.view === "allow-form")
        return {
          state: { view: "home" },
          patch: {
            allowed_bot_ids: roleIds.parse([
              ...new Set(
                interaction.fields
                  .getTextInputValue("ids")
                  .split(/[\s,]+/)
                  .filter(Boolean),
              ),
            ]),
          },
          notice: "✓ Allowed account IDs saved.",
        };
      if (state.view === "options-form")
        return {
          state: { view: "home" },
          patch: {
            delete_message_days: editorInteger(
              interaction.fields.getTextInputValue("days"),
              "days",
              0,
              7,
            ),
            ban_check_interval_minutes: editorInteger(
              interaction.fields.getTextInputValue("interval"),
              "minutes",
              1,
              1440,
            ),
          },
          notice: "✓ Options saved.",
        };
    }
    if (
      interaction.isStringSelectMenu() &&
      action === "targets" &&
      state.view === "roles"
    ) {
      if (interaction.values.length !== 1)
        throw new UserError("Choose one account scope.");
      return {
        patch: { quarantine_targets: interaction.values[0] },
        notice:
          interaction.values[0] === "all"
            ? "✓ Quarantine roles now target normal members and bots. Join protection still targets bot accounts only."
            : "✓ Quarantine roles now target bot accounts only.",
      };
    }
    if (
      interaction.isRoleSelectMenu() &&
      action === "roles" &&
      state.view === "roles"
    ) {
      const ids = [...new Set(interaction.values)];
      if (ids.length > 25)
        throw new UserError("Select at most 25 quarantine roles.");
      for (const role of ids)
        if (
          role === interaction.guildId ||
          !(await interaction.guild.roles.fetch(role))
        )
          throw new UserError("Choose server roles other than @everyone.");
      return {
        patch: { watch_roles: ids },
        notice: "✓ Quarantine roles saved.",
      };
    }
    if (
      interaction.isChannelSelectMenu() &&
      action === "log" &&
      state.view === "logs"
    ) {
      if (interaction.values.length !== 1)
        throw new UserError("Choose one log channel.");
      const channel = await sendableChannel(
        interaction.guild,
        interaction.values[0] ?? "",
      );
      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.GuildAnnouncement
      )
        throw new UserError("Choose a text or announcement channel.");
      return {
        patch: { log_channel_id: channel.id },
        notice: "✓ Log channel saved.",
      };
    }
    if (interaction.isButton()) {
      if (action === "home") return { state: { view: "home" } };
      if (state.view === "logs" && action === "clear-log")
        return { patch: { log_channel_id: null } };
      if (state.view === "home") {
        if (action === "quarantine") return { state: { view: "roles" } };
        if (action === "logs") return { state: { view: "logs" } };
        if (action === "join")
          return {
            patch: { ban_on_join: !config.ban_on_join },
            notice: "✓ Join policy saved. Allowed bots are always exempt.",
          };
        if (action === "toggle") {
          if (!config.enabled) {
            const me =
              interaction.guild.members.me ??
              (await interaction.guild.members.fetchMe());
            if (!me.permissions.has(PermissionFlagsBits.BanMembers))
              throw new UserError(
                "Give Caretaker Ban Members before enabling bot guard.",
              );
          }
          return {
            patch: { enabled: !config.enabled },
            notice: config.enabled
              ? "✓ Bot guard paused."
              : "✓ Bot guard enabled.",
          };
        }
      }
    }
    throw new UserError("Refresh the bot guard editor and try again.");
  }
}
