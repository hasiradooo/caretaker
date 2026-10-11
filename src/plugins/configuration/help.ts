import {
  InteractionContextType,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";
import type { Command, Plugin } from "../../core/plugin";
import { card, featureIcons } from "../../shared/messages";

/** Keep onboarding beside the configuration feature; no extra service is needed. */
export function createHelpCommand(plugins: Plugin[]): Command {
  return {
    data: new SlashCommandBuilder()
      .setName("help")
      .setDescription("See available features and how to get started")
      .setContexts(InteractionContextType.Guild),
    async execute(context, interaction) {
      const states = await Promise.all(
        plugins.map(async (plugin) => ({
          plugin,
          enabled: (await context.settings.raw(interaction.guildId, plugin.id))
            .enabled,
        })),
      );
      const enabled = new Set(
        states.filter((state) => state.enabled).map((state) => state.plugin.id),
      );
      const lines = ["### 🧭 Your commands"];
      if (enabled.has("levels"))
        lines.push(
          "`/level rank` — your XP and rank",
          "`/level leaderboard` — this server's leaderboard",
        );
      if (enabled.has("birthday"))
        lines.push("`/birthday set` — opt in to birthday celebrations");
      // Members retain access to their own data after celebrations are disabled.
      lines.push(
        "`/birthday show` / `/birthday remove` — view or delete your saved birthday",
      );
      if (enabled.has("tickets"))
        lines.push(
          "`/ticket open` — open or return to your private support thread; moderators close tickets",
        );
      if (enabled.has("roles"))
        lines.push(
          "Choose self roles from the role panel published by your moderators.",
        );
      if (!enabled.size)
        lines.push(
          "",
          "The server's features are not enabled yet. A server administrator can set them up with `/config`.",
        );
      const sections: string[] = [];
      if (interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild)) {
        sections.push(
          [
            "### ⚙️ Server setup",
            "`/config list` — see all features",
            "`/config view` — inspect settings and open the editor",
            "`/config set` — change one setting",
            "`/config enable` / `/config disable` — control a feature",
            "`/welcome settings` / `/goodbye settings` — open the greeting editor",
            "`/welcome set` / `/goodbye set` — choose a channel and enable greetings",
            "`/level settings` — manage rewards, announcements, XP and the command channel",
            "`/birthday settings` — edit birthday messages, channel and schedule",
            "`/ticket settings` — edit ticket channels, staff roles, panel and auto-close",
            "`/starboard settings` — edit highlight channel, emoji, threshold and watched channels",
            "`/moderation settings` — build rules for message edits, links, attachments and more",
            "`/botguard settings` — quarantine role bans, account scope, allowed accounts and bot join protection",
            "`/roles` / `/ticket panel` — publish configured panels",
          ].join("\n"),
        );
      }
      sections.push(
        [
          "### 📡 Features in this server",
          ...states.map(
            ({ plugin, enabled }) =>
              `${featureIcons[plugin.id] ?? "🔌"} **${plugin.name}** · ${enabled ? "On" : "Off"}`,
          ),
        ].join("\n"),
      );
      await interaction.editReply(
        card({
          title: `${context.env.BOT_NAME} help desk`,
          body: "Available commands and settings for this server.",
          sections: [lines.join("\n"), ...sections],
          footer:
            "Only you can see this guide · Settings are specific to this server",
        }),
      );
    },
  };
}
