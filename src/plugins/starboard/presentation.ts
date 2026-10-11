import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import { card, clipText } from "../../shared/messages";
import type { StarboardSettings } from "./config";

export function watchedChannels(config: StarboardSettings): string {
  return config.watch_channels === null
    ? "All eligible public channels"
    : config.watch_channels.length
      ? `${config.watch_channels.length} selected channel(s), including public threads`
      : "None";
}

export function starboardSummary(config: StarboardSettings): string {
  return `**Starboard:** ${config.enabled ? "Enabled" : "Paused"}\n**Destination:** ${config.channel_id ? `<#${config.channel_id}>` : "Not selected"}\n**Reaction:** ${config.emoji} · **Threshold:** ${config.threshold}\n**Self-stars:** ${config.allow_self_star ? "Counted" : "Ignored"}\n**Watching:** ${watchedChannels(config)}`;
}

/** One renderer for real highlights and the private example in the editor. */
export function starboardCard(input: {
  authorId: string;
  avatar: string;
  channelId?: string | null;
  count: number;
  emoji: string;
  createdAt: number;
  text: string;
  image?: string;
  url?: string;
  preview?: boolean;
}) {
  return card({
    title: "Community highlight",
    icon: "⭐",
    thumbnail: input.avatar,
    body: `<@${input.authorId}> · ${input.channelId ? `<#${input.channelId}>` : "An eligible channel"}\n${input.emoji} **${input.count}** · <t:${Math.floor(input.createdAt / 1000)}:f>`,
    sections: [
      clipText(
        input.text ||
          "*Attachment or embed — open the original message below.*",
        3200,
      ),
    ],
    image: input.image,
    actions: input.url
      ? [
          new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
              .setLabel("View original")
              .setEmoji("↗️")
              .setStyle(ButtonStyle.Link)
              .setURL(input.url),
          ),
        ]
      : [],
    footer: input.preview
      ? "Private preview · Example only · Nothing posted"
      : undefined,
  });
}
