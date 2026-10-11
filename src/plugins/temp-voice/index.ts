import { ChannelType, Events, PermissionFlagsBits } from "discord.js";
import type { Plugin } from "../../core/plugin";
import { KeyedQueue } from "../../shared/serial";
import { renderTemplate } from "../../shared/templates";
import { tempVoiceSchema } from "./config";

interface VoiceRow {
  guild_id: string;
  channel_id: string;
  creator_id: string;
  expires_at: Date | string;
}

export function createTempVoicePlugin(): Plugin {
  const queue = new KeyedQueue();
  return {
    id: "tempvc",
    name: "Temporary voice",
    description: "Join-to-create voice rooms with restart-safe cleanup",
    schema: tempVoiceSchema,
    register(context, events) {
      events.on(Events.VoiceStateUpdate, async (before, after) => {
        if (
          before.channelId === after.channelId ||
          !after.member ||
          after.member.user.bot
        )
          return;
        const config = await context.settings.get(
          after.guild.id,
          "tempvc",
          tempVoiceSchema,
        );
        if (
          !config.enabled ||
          !config.channel_id ||
          after.channelId !== config.channel_id
        )
          return;
        if (
          config.allowed_role_ids.length &&
          !config.allowed_role_ids.some((id) =>
            after.member?.roles.cache.has(id),
          )
        )
          return;
        await queue.run(`${after.guild.id}:${after.id}`, async () => {
          const member = after.member;
          const lobby = after.channel;
          if (
            !member ||
            lobby?.type !== ChannelType.GuildVoice ||
            member.voice.channelId !== config.channel_id
          )
            return;
          const me =
            after.guild.members.me ?? (await after.guild.members.fetchMe());
          if (
            !me.permissions.has([
              PermissionFlagsBits.ManageChannels,
              PermissionFlagsBits.MoveMembers,
            ])
          )
            return;
          const [existing] = await context.db.query<VoiceRow>(
            "select guild_id,channel_id,creator_id,expires_at from discord.temp_voice_channels where bot_id=$1 and guild_id=$2 and creator_id=$3 order by created_at desc limit 1",
            [context.botId, after.guild.id, after.id],
          );
          if (existing) {
            const channel = await after.guild.channels
              .fetch(existing.channel_id)
              .catch(() => null);
            // An expired room can finish its current conversation, but is not reused.
            if (
              channel?.type === ChannelType.GuildVoice &&
              new Date(existing.expires_at).getTime() > Date.now()
            ) {
              await member.voice.setChannel(channel);
              return;
            }
          }
          const channel = await after.guild.channels.create({
            name: renderTemplate(config.title_template, {
              display_name: member.displayName,
              username: member.user.username,
            }).slice(0, 100),
            type: ChannelType.GuildVoice,
            parent: lobby.parentId,
            userLimit: config.user_limit,
            permissionOverwrites: lobby.permissionOverwrites.cache.map(
              (overwrite) => ({
                id: overwrite.id,
                type: overwrite.type,
                allow: overwrite.allow.bitfield,
                deny: overwrite.deny.bitfield,
              }),
            ),
            reason: "Join-to-create voice room",
          });
          try {
            const expires = config.max_duration_minutes
              ? new Date(Date.now() + config.max_duration_minutes * 60000)
              : new Date("9999-01-01T00:00:00Z");
            await context.db.query(
              "insert into discord.temp_voice_channels (bot_id,guild_id,channel_id,creator_id,expires_at) values ($1,$2,$3,$4,$5)",
              [context.botId, after.guild.id, channel.id, member.id, expires],
            );
            await member.voice.setChannel(channel);
          } catch (error) {
            if (!channel.members.size) {
              await channel.delete("Voice room setup failed");
              await context.db.query(
                "delete from discord.temp_voice_channels where bot_id=$1 and guild_id=$2 and channel_id=$3",
                [context.botId, after.guild.id, channel.id],
              );
            }
            throw error;
          }
        });
      });
      events.every(30000, async () => {
        const rows = await context.db.query<VoiceRow>(
          "select guild_id,channel_id,creator_id,expires_at from discord.temp_voice_channels where bot_id=$1",
          [context.botId],
        );
        for (const row of rows) {
          try {
            const guild = context.client.guilds.cache.get(row.guild_id);
            if (!guild) continue;
            await queue.run(`${row.guild_id}:${row.creator_id}`, async () => {
              const channel = await guild.channels.fetch(row.channel_id);
              // Never disconnect occupants, even when the configured duration has elapsed.
              if (
                channel?.type === ChannelType.GuildVoice &&
                channel.members.size
              )
                return;
              if (channel?.type === ChannelType.GuildVoice)
                await channel.delete("Empty temporary voice room");
              if (!channel || channel.type === ChannelType.GuildVoice)
                await context.db.query(
                  "delete from discord.temp_voice_channels where bot_id=$1 and guild_id=$2 and channel_id=$3",
                  [context.botId, row.guild_id, row.channel_id],
                );
            });
          } catch (error) {
            context.log.warn(
              `Could not clean temporary voice room ${row.channel_id}`,
              error,
            );
          }
        }
      });
    },
    async stop() {
      await queue.drain();
    },
  };
}
