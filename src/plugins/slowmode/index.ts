import { ChannelType, Events, PermissionFlagsBits } from "discord.js";
import type { Plugin } from "../../core/plugin";
import { KeyedQueue } from "../../shared/serial";
import { slowmodeSchema } from "./config";

interface SlowmodeRow {
  guild_id: string;
  channel_id: string;
  previous_rate: number;
  applied_rate: number;
}

export function createSlowmodePlugin(): Plugin {
  const windows = new Map<string, number[]>();
  const queue = new KeyedQueue();
  return {
    id: "slowmode",
    name: "Adaptive slowmode",
    description:
      "Temporarily slow busy channels and restore their previous rate",
    schema: slowmodeSchema,
    register(context, events) {
      events.on(Events.MessageCreate, async (message) => {
        if (
          !message.inGuild() ||
          message.author.bot ||
          message.channel.type !== ChannelType.GuildText
        )
          return;
        const channel = message.channel;
        const config = await context.settings.get(
          message.guildId,
          "slowmode",
          slowmodeSchema,
        );
        if (
          !config.enabled ||
          (config.watch_channels && !config.watch_channels.includes(channel.id))
        )
          return;
        const now = Date.now();
        const window = (windows.get(channel.id) ?? []).filter(
          (time) => now - time < config.window_seconds * 1000,
        );
        window.push(now);
        windows.set(channel.id, window.slice(-config.message_threshold));
        if (window.length < config.message_threshold) return;
        await queue.run(channel.id, async () => {
          const me =
            message.guild.members.me ?? (await message.guild.members.fetchMe());
          if (
            !channel
              .permissionsFor(me)
              ?.has(PermissionFlagsBits.ManageChannels) ||
            channel.rateLimitPerUser >= config.rates.high
          )
            return;
          const inserted = await context.db.query(
            `insert into discord.channel_slowmodes (bot_id,guild_id,channel_id,previous_rate,applied_rate,expires_at)
            values ($1,$2,$3,$4,$5,$6) on conflict do nothing returning channel_id`,
            [
              context.botId,
              message.guildId,
              channel.id,
              channel.rateLimitPerUser,
              config.rates.high,
              new Date(Date.now() + config.slowmode_duration_ms),
            ],
          );
          // A stored override owns this channel until its restoration completes.
          // Do not replace a moderator's newer rate or lose the original baseline.
          if (!inserted.length) return;
          await channel.setRateLimitPerUser(
            config.rates.high,
            "Message activity exceeded configured threshold",
          );
          windows.delete(channel.id);
        });
      });
      events.every(5000, async () => {
        const rows = await context.db.query<SlowmodeRow>(
          "select guild_id,channel_id,previous_rate,applied_rate from discord.channel_slowmodes where bot_id=$1 and expires_at <= now()",
          [context.botId],
        );
        for (const row of rows) {
          try {
            await queue.run(row.channel_id, async () => {
              const guild = context.client.guilds.cache.get(row.guild_id);
              if (!guild) return;
              const channel = await guild.channels.fetch(row.channel_id);
              // If a moderator changed the rate meanwhile, preserve their choice.
              if (
                channel?.type === ChannelType.GuildText &&
                channel.rateLimitPerUser === row.applied_rate
              )
                await channel.setRateLimitPerUser(
                  row.previous_rate,
                  "Adaptive slowmode expired",
                );
              await context.db.query(
                "delete from discord.channel_slowmodes where bot_id=$1 and guild_id=$2 and channel_id=$3",
                [context.botId, row.guild_id, row.channel_id],
              );
            });
          } catch (error) {
            context.log.warn(
              `Could not restore slowmode in ${row.channel_id}`,
              error,
            );
          }
        }
        for (const [key, times] of windows)
          if ((times.at(-1) ?? 0) < Date.now() - 300000) windows.delete(key);
      });
    },
    async stop() {
      await queue.drain();
    },
  };
}
