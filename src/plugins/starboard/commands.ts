import {
  ChannelType,
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { Command } from "../../core/plugin";
import { requireManageGuild } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, successCard } from "../../shared/messages";
import { starboardSchema } from "./config";
import { starboardSummary } from "./presentation";
import type { StarboardSettingsEditor } from "./settings-editor";
import {
  starboardDestination,
  starboardEmoji,
  validateStarboardSetup,
} from "./setup";

export function starboardCommand(editor: StarboardSettingsEditor): Command {
  return {
    data: new SlashCommandBuilder()
      .setName("starboard")
      .setDescription("Manage community highlights")
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((sub) =>
        sub.setName("settings").setDescription("Open the starboard editor"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("status")
          .setDescription("Show this server's starboard settings"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("channel")
          .setDescription("Choose where new highlights appear")
          .addChannelOption((option) =>
            option
              .setName("channel")
              .setDescription("Starboard destination")
              .setRequired(true)
              .addChannelTypes(
                ChannelType.GuildText,
                ChannelType.GuildAnnouncement,
              ),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("threshold")
          .setDescription("Set the number of reactions required")
          .addIntegerOption((option) =>
            option
              .setName("count")
              .setDescription("Reactions needed for a highlight")
              .setMinValue(1)
              .setMaxValue(1000)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("emoji")
          .setDescription("Set the reaction emoji")
          .addStringOption((option) =>
            option
              .setName("emoji")
              .setDescription(
                "Paste one emoji, a server custom emoji, or its ID",
              )
              .setMaxLength(100)
              .setRequired(true),
          ),
      )
      .addSubcommand((sub) =>
        sub
          .setName("enable")
          .setDescription("Enable starboard after validating its settings"),
      )
      .addSubcommand((sub) =>
        sub
          .setName("disable")
          .setDescription("Pause starboard and keep existing highlights"),
      ),
    async execute(context, interaction) {
      requireManageGuild(interaction);
      const action = interaction.options.getSubcommand();
      if (action === "settings") return editor.open(context, interaction);
      const stored = await context.settings.raw(
        interaction.guildId,
        "starboard",
      );
      const config = starboardSchema.parse({
        ...stored.config,
        enabled: stored.enabled,
      });
      if (action === "status") {
        await interaction.editReply(
          card({
            title: "Starboard settings",
            icon: "⭐",
            body: starboardSummary(config),
            footer:
              "Open /starboard settings for buttons, inputs and a private preview",
          }),
        );
        return;
      }
      let patch: Record<string, unknown>;
      if (action === "channel") {
        const channel = await starboardDestination(
          interaction.guild,
          interaction.options.getChannel("channel", true).id,
        );
        patch = {
          channel_id: channel.id,
          ...(config.watch_channels?.includes(channel.id)
            ? {
                watch_channels: config.watch_channels.filter(
                  (id) => id !== channel.id,
                ),
              }
            : {}),
        };
      } else if (action === "threshold")
        patch = { threshold: interaction.options.getInteger("count", true) };
      else if (action === "emoji")
        patch = {
          emoji: await starboardEmoji(
            interaction.guild,
            interaction.options.getString("emoji", true),
          ),
        };
      else if (action === "enable" || action === "disable") {
        if (action === "enable")
          await validateStarboardSetup(interaction.guild, config);
        patch = { enabled: action === "enable" };
      } else
        throw new UserError("Open /starboard settings to manage starboard.");
      // Check the revision for shortcuts too: channel/emoji validation awaits
      // Discord and must not overwrite a concurrent administrator's edit.
      const saved = await context.settings.patch(
        interaction.guildId,
        "starboard",
        starboardSchema,
        patch,
        stored.revision,
      );
      await interaction.editReply(
        successCard(
          "Starboard settings saved",
          `${starboardSummary(saved)}\n\nUse /starboard settings to edit all options. Existing highlights are kept.`,
        ),
      );
    },
  };
}
