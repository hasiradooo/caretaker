import {
  ChannelType,
  type GuildTextBasedChannel,
  type Message,
  PermissionFlagsBits,
} from "discord.js";
import type { StarboardSettings } from "./config";

/** Keep starter reactions and highlights on the same public, watched sources. */
export function watchesStarboardSource(
  message: Pick<Message<true>, "channel" | "channelId" | "guild">,
  config: StarboardSettings,
): boolean {
  const { channel } = message;
  if (
    message.channelId === config.channel_id ||
    (channel.isThread() &&
      (channel.parentId === config.channel_id ||
        channel.type === ChannelType.PrivateThread))
  )
    return false;
  if (
    config.watch_channels &&
    !config.watch_channels.includes(message.channelId) &&
    !(
      channel.isThread() &&
      channel.parentId &&
      config.watch_channels.includes(channel.parentId)
    )
  )
    return false;
  return !!channel
    .permissionsFor(message.guild.roles.everyone)
    ?.has(PermissionFlagsBits.ViewChannel);
}

export function canShareStarboardSource(
  channel: GuildTextBasedChannel,
  target: GuildTextBasedChannel,
): boolean {
  const source = channel.isThread() ? channel.parent : channel;
  const destination = target.isThread() ? target.parent : target;
  return (
    !(source && "nsfw" in source && source.nsfw) ||
    !!(destination && "nsfw" in destination && destination.nsfw)
  );
}
