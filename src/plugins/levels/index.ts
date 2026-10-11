import {
  ChannelType,
  Events,
  InteractionContextType,
  SlashCommandBuilder,
} from "discord.js";
import type { Plugin } from "../../core/plugin";
import {
  noMentions,
  requireManageGuild,
  sendableChannel,
} from "../../shared/discord";
import { UserError } from "../../shared/errors";
import { card, progressBar, successCard } from "../../shared/messages";
import { KeyedQueue } from "../../shared/serial";
import { renderTemplate } from "../../shared/templates";
import { levelsSchema } from "./config";
import { MAX_TOTAL_XP, messageXp, totalXp } from "./math";
import { levelDisplayName, levelProfile } from "./presentation";
import { LevelsRepository } from "./repository";
import { executeRewardCommand, rewardCommands } from "./reward-commands";
import { syncLevelRewards } from "./rewards";
import { LevelSettingsEditor } from "./settings-editor";

// Keep XP changes and role replacement in order for each member. Other members
// proceed independently; an older award must not restore an earlier milestone.
const memberUpdates = new KeyedQueue();
const settingsEditor = new LevelSettingsEditor();

const command = new SlashCommandBuilder()
  .setName("level")
  .setDescription("Your server XP and rank")
  .setContexts(InteractionContextType.Guild)
  .addSubcommandGroup(rewardCommands)
  .addSubcommand((sub) =>
    sub
      .setName("settings")
      .setDescription(
        "Manage Server: manage rewards, announcements and XP in one editor",
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("rank")
      .setDescription("View a member's rank")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member"),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("leaderboard")
      .setDescription("View this server's leaderboard")
      .addIntegerOption((option) =>
        option
          .setName("page")
          .setDescription("Page")
          .setMinValue(1)
          .setMaxValue(10000),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("announcements")
      .setDescription("Manage Server: choose the level-up announcement channel")
      .addChannelOption((option) =>
        option
          .setName("channel")
          .setDescription("Send level-up announcements here")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("set")
      .setDescription("Manage Server: set lifetime XP")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member").setRequired(true),
      )
      .addIntegerOption((option) =>
        option
          .setName("xp")
          .setDescription("Lifetime XP")
          .setMinValue(0)
          .setMaxValue(MAX_TOTAL_XP)
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub
      .setName("reset")
      .setDescription("Manage Server: reset a member's XP")
      .addUserOption((option) =>
        option.setName("user").setDescription("Member").setRequired(true),
      ),
  );

export const levelsPlugin: Plugin = {
  id: "levels",
  name: "Levels",
  description: "XP, leaderboards and earned roles",
  schema: levelsSchema,
  commands: [
    {
      data: command,
      visibility: (interaction) =>
        ["rank", "leaderboard"].includes(interaction.options.getSubcommand())
          ? "public"
          : "private",
      async execute(context, interaction) {
        if (interaction.options.getSubcommandGroup(false) === "rewards") {
          await executeRewardCommand(context, interaction);
          return;
        }
        const subcommand = interaction.options.getSubcommand();
        if (subcommand === "settings") {
          await settingsEditor.open(context, interaction);
          return;
        }
        if (subcommand === "announcements") {
          requireManageGuild(interaction);
          const selected = interaction.options.getChannel("channel", true);
          const channel = await sendableChannel(interaction.guild, selected.id);
          if (
            channel.type !== ChannelType.GuildText &&
            channel.type !== ChannelType.GuildAnnouncement
          )
            throw new UserError(
              "Choose a server text or announcement channel.",
            );
          // Setup is available while levels are disabled, and never enables XP itself.
          await context.settings.patch(
            interaction.guildId,
            "levels",
            levelsSchema,
            {
              reward_channel_id: channel.id,
            },
          );
          await interaction.editReply(
            successCard(
              "Level-up channel saved",
              `Level-up announcements will mention the member in <#${channel.id}>.\nXP and role rewards continue to use this server's level settings.`,
            ),
          );
          return;
        }
        const config = await context.settings.get(
          interaction.guildId,
          "levels",
          levelsSchema,
        );
        if (!config.enabled)
          throw new UserError("Levels are disabled in this server.");
        const repository = new LevelsRepository(context.db, context.botId);
        const target = interaction.options.getUser("user") ?? interaction.user;
        if (["set", "reset"].includes(subcommand)) {
          requireManageGuild(interaction);
          const total =
            subcommand === "reset"
              ? 0
              : interaction.options.getInteger("xp", true);
          await memberUpdates.run(
            `${context.botId}:${interaction.guildId}:${target.id}`,
            async () => {
              await repository.set(interaction.guildId, target.id, total);
              const row = await repository.get(interaction.guildId, target.id);
              const member = await interaction.guild.members.fetch(target.id);
              const synced = row
                ? await syncLevelRewards(context, member, row.level, config)
                : false;
              await interaction.editReply(
                successCard(
                  "XP updated",
                  `**${levelDisplayName(member.displayName)}** now has **${total.toLocaleString()} lifetime XP**.\n${synced ? "Configured reward roles now match their highest unlocked milestone." : "XP was saved, but role rewards could not be fully updated. Check the bot's role permissions; the next XP award will retry."}`,
                ),
              );
            },
          );
          return;
        }
        if (
          config.command_channel_id &&
          interaction.channelId !== config.command_channel_id
        )
          throw new UserError(
            `Use <#${config.command_channel_id}> for level commands.`,
          );
        if (subcommand === "rank") {
          const row = await repository.get(interaction.guildId, target.id);
          const profile = await levelProfile(
            interaction.guild,
            target.id,
            target,
          );
          const level = row?.level ?? 0;
          const xp = row?.xp ?? 0;
          const next = (level + 1) * 3000;
          await interaction.editReply(
            card({
              title: "Member rank",
              icon: "✨",
              thumbnail: profile.avatar,
              body: `**${profile.name}**\n**Level ${level}**   ·   **${row ? `Rank #${row.rank}` : "Unranked"}**`,
              sections: [
                `### Next stop: level ${level + 1}\n${progressBar(xp, next)}\n${xp.toLocaleString()} / ${next.toLocaleString()} XP`,
                row
                  ? `**${totalXp(level, xp).toLocaleString()}** lifetime XP`
                  : "No XP yet. Join the conversation to get started!",
              ],
              footer: "Progress in this server",
            }),
          );
        } else {
          const rows = await repository.leaderboard(
            interaction.guildId,
            10,
            ((interaction.options.getInteger("page") ?? 1) - 1) * 10,
          );
          const entries = await Promise.all(
            rows.map(async (row) => {
              const profile = await levelProfile(
                interaction.guild,
                row.user_id,
              );
              return `${["🥇", "🥈", "🥉"][Number(row.rank) - 1] ?? `**#${row.rank}**`} **${profile.name}**\n-# Level ${row.level} · ${totalXp(row.level, row.xp).toLocaleString()} lifetime XP`;
            }),
          );
          await interaction.editReply(
            card({
              title: "Leaderboard",
              icon: "🏆",
              body: entries.length
                ? entries.join("\n\n")
                : "No entries on this page.",
              footer: `Page ${interaction.options.getInteger("page") ?? 1} · Use /level leaderboard page to explore`,
            }),
          );
        }
      },
    },
  ],
  component: (context, interaction) =>
    settingsEditor.handle(context, interaction),
  register(context, events) {
    const repository = new LevelsRepository(context.db, context.botId);
    events.on(Events.GuildMemberAdd, async (member) => {
      if (member.user.bot) return;
      await memberUpdates.run(
        `${context.botId}:${member.guild.id}:${member.id}`,
        async () => {
          const config = await context.settings.get(
            member.guild.id,
            "levels",
            levelsSchema,
          );
          if (!config.enabled || !config.reward_roles.length) return;
          // Joining does not reset XP or award a level. Returning members regain
          // their earned milestone; new members start with the level-zero role.
          const row = await repository.get(member.guild.id, member.id);
          await syncLevelRewards(context, member, row?.level ?? 0, config);
        },
      );
    });
    events.on(Events.MessageCreate, async (message) => {
      if (
        !message.inGuild() ||
        message.author.bot ||
        message.webhookId ||
        message.system
      )
        return;
      await memberUpdates.run(
        `${context.botId}:${message.guildId}:${message.author.id}`,
        async () => {
          const config = await context.settings.get(
            message.guildId,
            "levels",
            levelsSchema,
          );
          if (
            !config.enabled ||
            config.ignored_channels.includes(message.channelId) ||
            (message.channel.isThread() &&
              config.ignored_channels.includes(message.channel.parentId ?? ""))
          )
            return;
          const member =
            message.member ??
            (await message.guild.members.fetch(message.author.id));
          if (config.ignored_roles.some((role) => member.roles.cache.has(role)))
            return;
          const multiplier = Math.max(
            config.xp_multipliers.default,
            ...config.xp_multipliers.roles
              .filter((item) => member.roles.cache.has(item.role_id))
              .map((item) => item.multiplier),
          );
          const gain = messageXp(
            config.xp_gain.min,
            config.xp_gain.max,
            multiplier,
          );
          if (gain <= 0) return;
          const result = await repository.award(
            message.guildId,
            message.author.id,
            gain,
            config.xp_cooldown_seconds,
          );
          if (!result) return;
          await syncLevelRewards(context, member, result.row.level, config);
          if (result.row.level <= result.previousLevel) return;
          // XP and earned roles still work without announcements. Never fall back
          // to the conversation channel when an admin has not chosen a destination.
          if (!config.reward_channel_id) return;
          const channel = await sendableChannel(
            message.guild,
            config.reward_channel_id,
          );
          await channel.send({
            ...card({
              title: "Level up",
              icon: "✨",
              thumbnail: member.displayAvatarURL(),
              body: renderTemplate(config.reward_message, {
                user: `<@${message.author.id}>`,
                display_name: levelDisplayName(member.displayName),
                level: result.row.level,
                xp: result.row.xp,
                xp_next: (result.row.level + 1) * 3000,
              }),
              footer: `Level ${result.row.level} reached · Keep the conversation going`,
            }),
            // Only the member who earned the level may be notified, even in custom templates.
            allowedMentions: { ...noMentions, users: [message.author.id] },
          });
        },
      );
    });
  },
  async stop() {
    await memberUpdates.drain();
  },
};
