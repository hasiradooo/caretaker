import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { z } from "zod";
import type { Plugin } from "../../core/plugin";
import { requireManageGuild } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, featureIcons, successCard } from "../../shared/messages";
import { isRecord, pathPatch } from "../../shared/validation";
import { createHelpCommand } from "./help";

export function createConfigurationPlugin(plugins: Plugin[]): Plugin {
  const editors = new Map<
    string,
    {
      guildId: string;
      userId: string;
      pluginId: string;
      json: string;
      revision: string | null;
      expires: number;
    }
  >();
  const choices = plugins.map((plugin) => ({
    name: plugin.name,
    value: plugin.id,
  }));
  const pluginOption = (
    option: import("discord.js").SlashCommandStringOption,
  ) =>
    option
      .setName("plugin")
      .setDescription("Feature to configure")
      .setRequired(true)
      .addChoices(...choices);
  function find(id: string): Plugin {
    const plugin = plugins.find((item) => item.id === id);
    if (!plugin) throw new UserError("Unknown plugin.");
    return plugin;
  }
  const command = new SlashCommandBuilder()
    .setName("config")
    .setDescription("Configure this server's plugins")
    .setContexts(InteractionContextType.Guild)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((sub) =>
      sub.setName("list").setDescription("List plugin status"),
    )
    .addSubcommand((sub) =>
      sub
        .setName("view")
        .setDescription("View settings and open the editor")
        .addStringOption(pluginOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("enable")
        .setDescription("Enable a plugin in this server")
        .addStringOption(pluginOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("disable")
        .setDescription("Disable a plugin in this server")
        .addStringOption(pluginOption),
    )
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("Set one option using a JSON value")
        .addStringOption(pluginOption)
        .addStringOption((option) =>
          option
            .setName("key")
            .setDescription("Field path, e.g. xp_gain.min")
            .setRequired(true),
        )
        .addStringOption((option) =>
          option
            .setName("value")
            .setDescription(
              'JSON value, e.g. 15, true, "123456789012345678", or []',
            )
            .setRequired(true)
            .setMaxLength(4000),
        ),
    );
  return {
    id: "configuration",
    name: "Configuration",
    description: "Server administrator configuration",
    schema: z.object({ enabled: z.boolean().default(true) }),
    commands: [
      createHelpCommand(plugins),
      {
        data: command,
        async execute(context, interaction) {
          requireManageGuild(interaction);
          const action = interaction.options.getSubcommand();
          if (action === "list") {
            const rows = await Promise.all(
              plugins.map(
                async (plugin) =>
                  `${featureIcons[plugin.id] ?? "🔌"} **${plugin.name}** · ${(await context.settings.raw(interaction.guildId, plugin.id)).enabled ? "On" : "Off"}\n-# ${plugin.description}`,
              ),
            );
            await interaction.editReply(
              card({
                title: "Server settings",
                icon: "⚙️",
                body: "Every feature has its own settings for this server.",
                sections: [rows.join("\n\n")],
                footer:
                  "Start with /config view · Then use /config enable when ready",
              }),
            );
            return;
          }
          // Discord clients may briefly cache a removed subcommand. Reject it
          // before parsing options or writing any server settings.
          if (!["view", "enable", "disable", "set"].includes(action))
            throw new UserError(
              "This command is no longer available. Use /config view to edit this server's settings.",
            );
          const plugin = find(interaction.options.getString("plugin", true));
          if (action === "view") {
            const raw = await context.settings.raw(
              interaction.guildId,
              plugin.id,
            );
            const parsed = plugin.schema.safeParse({
              ...raw.config,
              enabled: raw.enabled,
            });
            const settings = parsed.success
              ? parsed.data
              : { ...raw.config, enabled: raw.enabled };
            const json = JSON.stringify(settings, null, 2);
            const editorId = randomUUID();
            for (const [id, editor] of editors)
              if (editor.expires < Date.now()) editors.delete(id);
            if (editors.size >= 1000) editors.clear();
            editors.set(editorId, {
              guildId: interaction.guildId,
              userId: interaction.user.id,
              pluginId: plugin.id,
              json,
              revision: raw.revision,
              expires: Date.now() + 900000,
            });
            await interaction.editReply({
              ...card({
                title: plugin.name,
                icon: featureIcons[plugin.id] ?? "⚙️",
                body: `**${raw.enabled ? "🟢 Enabled" : "⚪ Disabled"}** · ${plugin.description}${parsed.success ? "" : "\n⚠️ Existing settings need repair."}`,
                sections: [
                  json.length < 1500
                    ? `### Current settings\n\`\`\`json\n${json.replaceAll("```", "`\u200b``")}\n\`\`\``
                    : "Full settings are in the file below.",
                ],
                footer:
                  "Edit below, or use /config set for one field · Editor expires in 15 minutes",
                fileNames: [`${plugin.id}.json`],
                actions:
                  json.length <= 4000
                    ? [
                        new ActionRowBuilder<ButtonBuilder>().addComponents(
                          new ButtonBuilder()
                            .setCustomId(`configuration:edit:${editorId}`)
                            .setLabel("Edit settings")
                            .setEmoji("✏️")
                            .setStyle(ButtonStyle.Primary),
                        ),
                      ]
                    : [],
              }),
              files: [
                new AttachmentBuilder(Buffer.from(json), {
                  name: `${plugin.id}.json`,
                }),
              ],
            });
            return;
          }
          let patch: Record<string, unknown>;
          if (action === "enable" || action === "disable")
            patch = { enabled: action === "enable" };
          else {
            let value: unknown;
            try {
              value = JSON.parse(interaction.options.getString("value", true));
            } catch {
              throw new UserError(
                "Enter a JSON value. Put strings and Discord IDs in double quotes.",
              );
            }
            patch = pathPatch(
              interaction.options.getString("key", true),
              value,
            );
            const root = Object.keys(patch)[0];
            if (!root || !Object.hasOwn(plugin.schema.parse({}), root))
              throw new UserError(
                "Unknown setting. Use /config view to see available fields.",
              );
          }
          await context.settings.patch(
            interaction.guildId,
            plugin.id,
            plugin.schema,
            patch,
          );
          await interaction.editReply(
            successCard(
              "Settings saved",
              `${plugin.name} settings have been updated for this server.`,
            ),
          );
        },
      },
    ],
    async component(context, interaction) {
      if (!interaction.isButton() && !interaction.isModalSubmit()) return;
      const [, action, editorId] = interaction.customId.split(":");
      const editor = editors.get(editorId ?? "");
      if (!editor || editor.expires < Date.now())
        throw new UserError("This editor expired. Run /config view again.");
      if (
        editor.userId !== interaction.user.id ||
        editor.guildId !== interaction.guildId ||
        !interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)
      )
        throw new UserError(
          "Only the administrator who opened this editor can use it.",
        );
      const plugin = find(editor.pluginId);
      if (interaction.isButton() && action === "edit") {
        // No database round-trip before showModal. Saving checks the original revision.
        const json = editor.json;
        if (json.length > 4000)
          throw new UserError(
            "Use /config set to edit this large configuration.",
          );
        await interaction.showModal(
          new ModalBuilder()
            .setCustomId(`configuration:save:${editorId}`)
            .setTitle(`${plugin.name} settings`)
            .addComponents(
              new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                  .setCustomId("json")
                  .setLabel("Settings (JSON)")
                  .setStyle(TextInputStyle.Paragraph)
                  .setRequired(true)
                  .setMaxLength(4000)
                  .setValue(json),
              ),
            ),
        );
      } else if (interaction.isModalSubmit() && action === "save") {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        let patch: unknown;
        try {
          patch = JSON.parse(interaction.fields.getTextInputValue("json"));
        } catch {
          throw new UserError("Invalid JSON. No settings were saved.");
        }
        if (!isRecord(patch))
          throw new UserError("Settings must be a JSON object.");
        await context.settings.patch(
          interaction.guildId,
          plugin.id,
          plugin.schema,
          patch,
          editor.revision,
        );
        editors.delete(editorId ?? "");
        await interaction.editReply(
          successCard(
            "Settings saved",
            `${plugin.name} settings have been updated for this server.`,
          ),
        );
      }
    },
  };
}
