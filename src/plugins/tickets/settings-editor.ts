import {
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ComponentType,
  type GuildMember,
  ModalBuilder,
  RoleSelectMenuBuilder,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
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
import { type TicketSettings, ticketsSchema } from "./config";
import { ticketPanel } from "./presentation";
import {
  ticketDestination,
  ticketParent,
  ticketStaffRole,
  validateTicketSetup,
} from "./setup";

const destinations = {
  parent_channel_id: "Ticket threads",
  panel_channel_id: "Support panel",
  admin_channel_id: "Staff alerts",
  transcript_channel_id: "Transcripts",
} as const;
type Destination = keyof typeof destinations;
type Tab = "channels" | "staff" | "panel" | "auto";
interface State {
  view:
    | Tab
    | "destination"
    | "panel-modal"
    | "draft"
    | "auto-modal"
    | "exempt"
    | "timeout"
    | "timeout-modal";
  destination?: Destination;
  roleMode?: "add" | "remove";
  roleId?: string;
  draft?: TicketSettings["panel"];
}
type Session = EditorSession<TicketSettings, State>;
const channelLabel = (id: string | null) => (id ? `<#${id}>` : "Not selected");
const roleList = (ids: string[]) =>
  ids.length ? clipText(ids.map((id) => `<@&${id}>`).join(", "), 650) : "None";

export class TicketSettingsEditor extends SettingsEditor<
  TicketSettings,
  State
> {
  constructor(now?: () => number) {
    super(
      "tickets",
      ticketsSchema,
      "/ticket settings",
      () => ({ view: "channels" }),
      now,
    );
  }

  protected render(session: Session, _member: GuildMember, notice?: string) {
    const { config, state } = session;
    const { button, id } = this.controls(session);
    const active: Tab = ["destination", "channels"].includes(state.view)
      ? "channels"
      : ["panel", "draft", "panel-modal"].includes(state.view)
        ? "panel"
        : state.view === "staff"
          ? "staff"
          : "auto";
    const navigation = editorRow(
      ...(
        [
          ["channels", "Channels"],
          ["staff", "Staff roles"],
          ["panel", "Support panel"],
          ["auto", "Auto-close"],
        ] as const
      ).map(([tab, label]) =>
        button(
          tab,
          label,
          tab === active ? ButtonStyle.Primary : ButtonStyle.Secondary,
        ).setDisabled(tab === state.view),
      ),
      button("toggle", config.enabled ? "Pause tickets" : "Enable tickets"),
    );
    if (state.view === "panel" || state.view === "draft") {
      const preview = ticketPanel(
        { ...config, panel: state.draft ?? config.panel },
        true,
      );
      return {
        ...preview,
        components: [
          new TextDisplayBuilder().setContent(
            `**Tickets:** ${config.enabled ? "Enabled" : "Paused"} · **Publish to:** ${channelLabel(config.panel_channel_id)}${notice ? `\n${notice}` : ""}`,
          ),
          ...preview.components.filter(
            (component) => component.toJSON().type !== ComponentType.ActionRow,
          ),
          // The panel's Open ticket button remains disabled in the private preview.
          navigation,
          ...preview.components.filter(
            (component) => component.toJSON().type === ComponentType.ActionRow,
          ),
          editorRow(
            button(
              "panel-edit",
              state.draft ? "Edit draft" : "Edit panel text",
            ),
            ...(state.draft
              ? [
                  button("panel-save", "Save panel text", ButtonStyle.Success),
                  button("discard", "Discard draft"),
                ]
              : [
                  button(
                    "publish",
                    "Publish panel",
                    ButtonStyle.Success,
                  ).setDisabled(!config.enabled || !config.panel_channel_id),
                ]),
            button("panel-destination", "Choose panel channel"),
            button("refresh", "Refresh"),
          ),
        ],
      };
    }
    let body = `**Tickets:** ${config.enabled ? "Enabled" : "Paused"}`;
    const sections: string[] = notice ? [notice] : [];
    const actions = [navigation];
    if (state.view === "channels") {
      sections.push(
        Object.entries(destinations)
          .map(
            ([key, label]) =>
              `**${label}:** ${channelLabel(config[key as Destination])}`,
          )
          .join("\n"),
      );
      sections.push(
        "Tickets open as private threads inside the Ticket threads channel. If unset, the support-panel channel is used. Alerts and transcripts are optional.",
      );
      actions.push(
        editorRow(
          new StringSelectMenuBuilder()
            .setCustomId(id("choose-destination"))
            .setPlaceholder("Choose which destination to edit")
            .addOptions(
              Object.entries(destinations).map(([value, label]) => ({
                value,
                label,
              })),
            ),
        ),
        editorRow(button("refresh", "Refresh")),
      );
    } else if (state.view === "destination" && state.destination) {
      const field = state.destination;
      body += `\n**${destinations[field]}:** ${channelLabel(config[field])}`;
      sections.push(
        field === "transcript_channel_id"
          ? "Choose a private staff channel where @everyone cannot View Channel. The bot needs Attach Files. Check that other roles cannot read private transcripts."
          : field === "panel_channel_id"
            ? "This saves where the public support panel will be published. Use Support panel to preview and publish it."
            : "Choose a destination. This change applies to future ticket activity.",
      );
      actions.push(
        editorRow(
          new ChannelSelectMenuBuilder()
            .setCustomId(id("destination"))
            .setPlaceholder(destinations[field])
            .setChannelTypes(
              ...(field === "parent_channel_id"
                ? [ChannelType.GuildText]
                : [ChannelType.GuildText, ChannelType.GuildAnnouncement]),
            )
            .setMinValues(1)
            .setMaxValues(1),
        ),
        editorRow(
          button("clear-destination", "Clear destination").setDisabled(
            !config[field],
          ),
        ),
      );
    } else if (state.view === "staff" || state.view === "exempt") {
      const exempt = state.view === "exempt";
      const roles = exempt
        ? config.role_time_limits.excluded
        : config.mods_role_ids;
      body += `\n**${exempt ? "Exempt opener roles" : "Staff roles"}:** ${roleList(roles)}`;
      sections.push(
        exempt
          ? "Tickets opened by members with these roles will not close automatically."
          : "Members with these roles are added to new private ticket threads and mentioned only in the staff alerts channel. Only ticket staff can claim or close tickets. Existing tickets keep their membership; Manage Server members can also use staff commands.",
      );
      actions.push(
        editorRow(
          new RoleSelectMenuBuilder()
            .setCustomId(id("roles"))
            .setPlaceholder(
              `${state.roleMode === "remove" ? "Remove" : "Add"} ${exempt ? "exempt" : "staff"} roles`,
            )
            .setMinValues(1)
            .setMaxValues(25),
        ),
        editorRow(
          button("roles-add", "Add roles").setDisabled(
            state.roleMode !== "remove",
          ),
          button("roles-remove", "Remove roles").setDisabled(
            state.roleMode === "remove",
          ),
          button("refresh", "Refresh"),
        ),
      );
    } else if (state.view === "timeout") {
      const limit = config.role_time_limits.included.find(
        (item) => item.role_id === state.roleId,
      );
      sections.push(
        `**Custom timeouts:**\n${clipText(config.role_time_limits.included.map((item) => `<@&${item.role_id}> — ${item.threshold_seconds} seconds`).join("\n") || "None", 900)}`,
        state.roleId
          ? `**Selected:** <@&${state.roleId}> · ${limit ? `${limit.threshold_seconds} seconds` : "Default timeout"}`
          : "Choose a role to set its custom inactivity timeout. The longest matching timeout wins; exemptions take priority.",
      );
      actions.push(
        editorRow(
          new RoleSelectMenuBuilder()
            .setCustomId(id("timeout-role"))
            .setPlaceholder("Choose an opener role")
            .setMinValues(1)
            .setMaxValues(1),
        ),
        editorRow(
          button("timeout-edit", "Set timeout").setDisabled(!state.roleId),
          button("timeout-remove", "Remove custom timeout").setDisabled(!limit),
        ),
      );
    } else {
      body += `\n**Automatic closure:** ${config.auto_close.enabled ? "On" : "Off"}\n**Idle time:** ${config.auto_close.threshold_ms / 60000} minutes\n**Warning before closure:** ${config.auto_close.warning_ms / 60000} minutes`;
      sections.push(
        `**Close reason:** ${clipText(config.auto_close.reason, 400)}`,
        "Only the ticket opener's messages restart the timer. They receive a warning in their thread before closure. Late checks still allow the full warning period. Pausing tickets stops automatic closure and clears pending warnings. For shorter role timeouts, the warning period is capped at that timeout.",
        `**Exempt roles:** ${roleList(config.role_time_limits.excluded)}\n**Custom role timeouts:** ${config.role_time_limits.included.length}`,
      );
      actions.push(
        editorRow(
          button("auto-edit", "Timer, warning & reason"),
          button(
            "auto-toggle",
            config.auto_close.enabled
              ? "Turn auto-close off"
              : "Turn auto-close on",
          ),
          button("exempt", "Exempt roles"),
          button("timeout", "Role timeouts"),
          button("refresh", "Refresh"),
        ),
      );
    }
    return card({
      title: "Ticket editor",
      icon: "🎫",
      body,
      sections,
      actions,
      footer: "Manage Server · Changes apply only to this server",
    });
  }

  protected form(session: Session, action: string) {
    const { config, state } = session;
    if (action === "panel-edit" && ["panel", "draft"].includes(state.view)) {
      const panel = state.draft ?? config.panel;
      return {
        state: { ...state, view: "panel-modal" as const },
        modal: new ModalBuilder()
          .setTitle("Support panel text")
          .addLabelComponents(
            editorInput("Title", "title", panel.title, 100),
            editorInput("Message", "message", panel.message, 1800, true),
            editorInput("Button label", "label", panel.button_label, 80),
          ),
      };
    }
    if (action === "auto-edit" && state.view === "auto")
      return {
        state: { view: "auto-modal" as const },
        modal: new ModalBuilder()
          .setTitle("Ticket inactivity rules")
          .addLabelComponents(
            editorInput(
              "Idle time in minutes (1–43200)",
              "minutes",
              String(Math.ceil(config.auto_close.threshold_ms / 60000)),
              5,
            ),
            editorInput(
              "Warning before closure in minutes (1–43200)",
              "warning",
              String(Math.ceil(config.auto_close.warning_ms / 60000)),
              5,
            ),
            editorInput(
              "Close reason",
              "reason",
              config.auto_close.reason,
              400,
              true,
            ),
          ),
      };
    if (action === "timeout-edit" && state.view === "timeout" && state.roleId)
      return {
        state: { ...state, view: "timeout-modal" as const },
        modal: new ModalBuilder()
          .setTitle("Role inactivity timeout")
          .addLabelComponents(
            editorInput(
              "Idle time in seconds (60–2592000)",
              "seconds",
              String(
                config.role_time_limits.included.find(
                  (item) => item.role_id === state.roleId,
                )?.threshold_seconds ??
                  Math.ceil(config.auto_close.threshold_ms / 1000),
              ),
              7,
            ),
          ),
      };
    return undefined;
  }

  protected async update(
    context: Context,
    session: Session,
    interaction: EditorInteraction,
    action: string,
  ): Promise<EditorChange<State>> {
    const { config, state } = session;
    if (interaction.isModalSubmit() && action === "submit") {
      if (state.view === "panel-modal") {
        const draft = {
          title: interaction.fields.getTextInputValue("title").trim(),
          message: interaction.fields.getTextInputValue("message").trim(),
          button_label: interaction.fields.getTextInputValue("label").trim(),
        };
        ticketsSchema.parse({ ...config, panel: draft });
        return { state: { view: "draft", draft } };
      }
      if (state.view === "auto-modal") {
        const minutes = editorInteger(
          interaction.fields.getTextInputValue("minutes"),
          "number of minutes",
          1,
          43200,
        );
        const warning = editorInteger(
          interaction.fields.getTextInputValue("warning"),
          "warning minutes",
          1,
          43200,
        );
        const reason = interaction.fields.getTextInputValue("reason").trim();
        if (!reason || reason.length > 400)
          throw new UserError(
            "Enter a close reason between 1 and 400 characters.",
          );
        return {
          state: { view: "auto" },
          patch: {
            auto_close: {
              threshold_ms: minutes * 60000,
              warning_ms: warning * 60000,
              reason,
            },
          },
          notice: "✓ Inactivity rules saved.",
        };
      }
      if (state.view === "timeout-modal" && state.roleId) {
        await ticketStaffRole(interaction.guild, state.roleId);
        const seconds = editorInteger(
          interaction.fields.getTextInputValue("seconds"),
          "number of seconds",
          60,
          2592000,
        );
        const included = config.role_time_limits.included.filter(
          (item) => item.role_id !== state.roleId,
        );
        included.push({ role_id: state.roleId, threshold_seconds: seconds });
        return {
          state: { view: "timeout", roleId: state.roleId },
          patch: { role_time_limits: { included } },
          notice: "✓ Custom role timeout saved.",
        };
      }
    }
    if (
      interaction.isStringSelectMenu() &&
      action === "choose-destination" &&
      state.view === "channels"
    ) {
      const value = interaction.values[0];
      if (!value || !Object.hasOwn(destinations, value))
        throw new UserError("Choose one of the listed destinations.");
      return {
        state: { view: "destination", destination: value as Destination },
      };
    }
    if (
      interaction.isChannelSelectMenu() &&
      action === "destination" &&
      state.view === "destination" &&
      state.destination
    ) {
      const value = interaction.values[0] ?? "";
      const channel =
        state.destination === "parent_channel_id"
          ? await ticketParent(interaction.guild, value)
          : await ticketDestination(
              interaction.guild,
              value,
              state.destination === "transcript_channel_id",
            );
      return {
        patch: { [state.destination]: channel.id },
        notice: `✓ ${destinations[state.destination]} saved.`,
      };
    }
    if (
      interaction.isRoleSelectMenu() &&
      action === "roles" &&
      ["staff", "exempt"].includes(state.view)
    ) {
      const existing =
        state.view === "staff"
          ? config.mods_role_ids
          : config.role_time_limits.excluded;
      const selected = [...new Set(interaction.values)];
      if (!selected.length || selected.length > 25)
        throw new UserError("Choose between 1 and 25 roles.");
      if (state.roleMode !== "remove")
        for (const role of selected)
          await ticketStaffRole(interaction.guild, role);
      const next =
        state.roleMode === "remove"
          ? existing.filter((role) => !selected.includes(role))
          : [...new Set([...existing, ...selected])];
      if (next.length > 100)
        throw new UserError("At most 100 roles can be saved in this list.");
      return {
        patch:
          state.view === "staff"
            ? { mods_role_ids: next }
            : { role_time_limits: { excluded: next } },
        notice: "✓ Roles saved.",
      };
    }
    if (
      interaction.isRoleSelectMenu() &&
      action === "timeout-role" &&
      state.view === "timeout"
    ) {
      const role = await ticketStaffRole(
        interaction.guild,
        interaction.values[0] ?? "",
      );
      return { state: { view: "timeout", roleId: role.id } };
    }
    if (interaction.isButton()) {
      if (
        ["channels", "staff", "panel", "auto", "exempt", "timeout"].includes(
          action,
        )
      )
        return { state: { view: action as State["view"] } };
      if (
        action === "panel-destination" &&
        ["panel", "draft"].includes(state.view)
      )
        return {
          state: { view: "destination", destination: "panel_channel_id" },
        };
      if (action === "toggle") {
        if (!config.enabled)
          await validateTicketSetup(interaction.guild, config);
        return {
          patch: { enabled: !config.enabled },
          notice: config.enabled
            ? "✓ Tickets paused. Existing tickets can still be closed."
            : "✓ Tickets enabled.",
        };
      }
      if (
        action === "clear-destination" &&
        state.view === "destination" &&
        state.destination
      )
        return {
          patch: { [state.destination]: null },
          notice: "✓ Destination cleared.",
        };
      if (
        ["roles-add", "roles-remove"].includes(action) &&
        ["staff", "exempt"].includes(state.view)
      )
        return {
          state: {
            ...state,
            roleMode: action === "roles-remove" ? "remove" : "add",
          },
        };
      if (action === "panel-save" && state.view === "draft" && state.draft)
        return {
          patch: { panel: state.draft },
          state: { view: "panel" },
          notice:
            "✓ Panel text saved. Publish a new panel when ready; existing posts are unchanged.",
        };
      if (action === "discard" && state.view === "draft")
        return { state: { view: "panel" } };
      if (action === "publish" && state.view === "panel") {
        await this.assertCurrent(context, session);
        if (!config.enabled)
          throw new UserError("Enable tickets before publishing the panel.");
        if (!config.panel_channel_id)
          throw new UserError("Choose a support-panel channel first.");
        await validateTicketSetup(interaction.guild, config);
        const channel = await ticketDestination(
          interaction.guild,
          config.panel_channel_id,
        );
        const posted = await channel.send(ticketPanel(config));
        return {
          state: { view: "channels" },
          notice: `✓ Support panel published in <#${channel.id}>. [Open panel](${posted.url})`,
        };
      }
      if (action === "auto-toggle" && state.view === "auto")
        return {
          patch: { auto_close: { enabled: !config.auto_close.enabled } },
          notice: "✓ Automatic closure setting saved.",
        };
      if (
        action === "timeout-remove" &&
        state.view === "timeout" &&
        state.roleId
      )
        return {
          patch: {
            role_time_limits: {
              included: config.role_time_limits.included.filter(
                (item) => item.role_id !== state.roleId,
              ),
            },
          },
          notice: "✓ Custom timeout removed.",
        };
    }
    throw new UserError("This control is outdated. Refresh the ticket editor.");
  }
}
