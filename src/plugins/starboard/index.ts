import {
  Events,
  type Guild,
  type MessageReaction,
  type PartialMessageReaction,
  PermissionFlagsBits,
} from "discord.js";
import type { Context, Plugin } from "../../core/plugin";
import { sendableChannel } from "../../shared/discord";
import { KeyedQueue } from "../../shared/serial";
import { starboardCommand } from "./commands";
import { starboardSchema } from "./config";
import { starboardCard } from "./presentation";
import { StarboardSettingsEditor } from "./settings-editor";
import { matchesStarboardEmoji } from "./setup";

interface StarboardRow {
  starboard_message_id: string;
  starboard_channel_id: string | null;
  star_count: number;
}

function isMissingMessage(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === 10008;
}

export function createStarboardPlugin(): Plugin {
  const queue = new KeyedQueue();
  const editor = new StarboardSettingsEditor();
  async function remove(
    context: Context,
    guild: Guild,
    sourceId: string,
  ): Promise<void> {
    await queue.run(`${guild.id}:${sourceId}`, async () => {
      const [row] = await context.db.query<StarboardRow>(
        "select starboard_message_id,starboard_channel_id from discord.starboards where bot_id=$1 and guild_id=$2 and source_message_id=$3",
        [context.botId, guild.id, sourceId],
      );
      if (!row) return;
      const config = await context.settings.get(
        guild.id,
        "starboard",
        starboardSchema,
      );
      const channelId = row.starboard_channel_id ?? config.channel_id;
      if (!channelId) return;
      const target = await guild.channels.fetch(channelId);
      if (target?.isTextBased()) {
        await target.messages
          .delete(row.starboard_message_id)
          .catch((error: unknown) => {
            if (!isMissingMessage(error)) throw error;
          });
      }
      await context.db.query(
        "delete from discord.starboards where bot_id=$1 and guild_id=$2 and source_message_id=$3",
        [context.botId, guild.id, sourceId],
      );
    });
  }
  async function update(
    context: Context,
    input: MessageReaction | PartialMessageReaction,
    removedEmoji = false,
  ): Promise<void> {
    const reaction = input.partial ? await input.fetch() : input;
    const message = reaction.message.partial
      ? await reaction.message.fetch()
      : reaction.message;
    if (!message.inGuild() || message.author.bot) return;
    const config = await context.settings.get(
      message.guildId,
      "starboard",
      starboardSchema,
    );
    if (
      !config.enabled ||
      !config.channel_id ||
      message.channelId === config.channel_id ||
      (message.channel.isThread() &&
        message.channel.parentId === config.channel_id)
    )
      return;
    if (!matchesStarboardEmoji(config.emoji, reaction.emoji)) return;
    if (removedEmoji) {
      await remove(context, message.guild, message.id);
      return;
    }
    if (
      config.watch_channels &&
      !config.watch_channels.includes(message.channelId) &&
      !(
        message.channel.isThread() &&
        message.channel.parentId &&
        config.watch_channels.includes(message.channel.parentId)
      )
    )
      return;
    // Never copy private-channel or private-thread content into a public highlight feed.
    if (message.channel.isThread() && message.channel.type === 12) return;
    if (
      !message.channel
        .permissionsFor(message.guild.roles.everyone)
        ?.has(PermissionFlagsBits.ViewChannel)
    )
      return;
    await queue.run(`${message.guildId}:${message.id}`, async () => {
      const [existing] = await context.db.query<StarboardRow>(
        "select starboard_message_id,starboard_channel_id,star_count from discord.starboards where bot_id=$1 and guild_id=$2 and source_message_id=$3",
        [context.botId, message.guildId, message.id],
      );
      const target = await sendableChannel(
        message.guild,
        existing?.starboard_channel_id ?? config.channel_id ?? "",
      );
      const source = message.channel.isThread()
        ? message.channel.parent
        : message.channel;
      const destination = target.isThread() ? target.parent : target;
      if (
        source &&
        "nsfw" in source &&
        source.nsfw &&
        !(destination && "nsfw" in destination && destination.nsfw)
      )
        return;
      let count = reaction.count ?? 0;
      if (
        !config.allow_self_star &&
        (await reaction.users
          .fetch({
            limit: 1,
            after: (BigInt(message.author.id) - 1n).toString(),
          })
          .then((users) => users.has(message.author.id)))
      )
        count--;
      if (count < config.threshold) {
        if (existing) {
          await target.messages
            .delete(existing.starboard_message_id)
            .catch((error: unknown) => {
              if (!isMissingMessage(error)) throw error;
            });
          await context.db.query(
            "delete from discord.starboards where bot_id=$1 and guild_id=$2 and source_message_id=$3",
            [context.botId, message.guildId, message.id],
          );
        }
        return;
      }
      const attachment = message.attachments.find(
        (file) => file.contentType?.startsWith("image/") && !file.spoiler,
      );
      const payload = starboardCard({
        authorId: message.author.id,
        avatar: message.author.displayAvatarURL(),
        channelId: message.channelId,
        emoji: reaction.emoji.toString(),
        count,
        createdAt: message.createdTimestamp,
        text: message.content,
        image: attachment?.url,
        url: message.url,
      });
      if (existing) {
        // Existing highlights may still be legacy embeds. V2 conversion must clear them.
        await target.messages.edit(existing.starboard_message_id, {
          ...payload,
          content: null,
          embeds: [],
        });
        await context.db.query(
          "update discord.starboards set star_count=$4,starboard_channel_id=$5 where bot_id=$1 and guild_id=$2 and source_message_id=$3",
          [context.botId, message.guildId, message.id, count, target.id],
        );
      } else {
        const posted = await target.send(payload);
        try {
          await context.db.query(
            "insert into discord.starboards (bot_id,guild_id,source_message_id,source_channel_id,starboard_message_id,star_count,starboard_channel_id) values ($1,$2,$3,$4,$5,$6,$7)",
            [
              context.botId,
              message.guildId,
              message.id,
              message.channelId,
              posted.id,
              count,
              target.id,
            ],
          );
        } catch (error) {
          await posted.delete().catch(() => undefined);
          throw error;
        }
      }
    });
  }
  return {
    id: "starboard",
    name: "Starboard",
    description: "Highlight community favourites",
    schema: starboardSchema,
    commands: [starboardCommand(editor)],
    async component(context, interaction) {
      if (
        (interaction.isMessageComponent() || interaction.isModalSubmit()) &&
        interaction.customId.startsWith("starboard:editor:")
      )
        await editor.handle(context, interaction);
    },
    register(context, events) {
      events.on(Events.MessageReactionAdd, (reaction) =>
        update(context, reaction),
      );
      events.on(Events.MessageReactionRemove, (reaction) =>
        update(context, reaction),
      );
      events.on(Events.MessageReactionRemoveEmoji, (reaction) =>
        update(context, reaction, true),
      );
      events.on(Events.MessageReactionRemoveAll, async (message) => {
        if (message.guild) await remove(context, message.guild, message.id);
      });
      events.on(Events.MessageBulkDelete, async (messages) => {
        for (const message of messages.values())
          if (message.guild) await remove(context, message.guild, message.id);
      });
      events.on(Events.MessageDelete, async (message) => {
        if (message.guild) await remove(context, message.guild, message.id);
      });
    },
    async stop() {
      await queue.drain();
    },
  };
}
