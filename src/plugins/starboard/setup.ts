import { ChannelType, type Guild, PermissionFlagsBits } from "discord.js";
import { sendableChannel } from "../../shared/discord";
import { UserError } from "../../shared/errors";
import type { StarboardSettings } from "./config";

export const sourceChannelTypes = [
    ChannelType.GuildText,
    ChannelType.GuildAnnouncement,
    ChannelType.GuildForum,
    ChannelType.GuildMedia,
] as const;

export async function starboardDestination(guild: Guild, id: string) {
    const channel = await sendableChannel(guild, id);
    if (
        ![ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(
            channel.type,
        )
    )
        throw new UserError(
            "Choose a text or announcement channel for the starboard.",
        );
    return channel;
}

export async function starboardSource(
    guild: Guild,
    id: string,
    destination: string | null,
) {
    if (id === destination)
        throw new UserError(
            "The starboard destination cannot also be a watched channel.",
        );
    const channel = await guild.channels.fetch(id);
    if (!channel || !sourceChannelTypes.some((type) => type === channel.type))
        throw new UserError(
            "Watch a text, announcement, forum or media channel. Public threads inside it are included.",
        );
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (
        !channel
            .permissionsFor(me)
            ?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
            ])
    )
        throw new UserError(
            "I need View Channel and Read Message History in each watched channel.",
        );
    return channel;
}

function customEmojiId(value: string) {
    return /^\d{17,20}$/.test(value)
        ? value
        : /^<a?:[A-Za-z0-9_]{2,32}:(\d{17,20})>$/.exec(value)?.[1];
}

/** Validate pasted emoji, not emoji names such as :star:. Store a custom emoji's
 * canonical Discord form; matching below uses its ID so renaming still works. */
export async function starboardEmoji(
    guild: Guild,
    input: string,
): Promise<string> {
    const value = input.trim();
    const id = customEmojiId(value);
    if (id) {
        const emoji = await guild.emojis.fetch(id).catch((error: unknown) => {
            if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === 10014
            )
                return null;
            throw error;
        });
        if (!emoji || !emoji.available)
            throw new UserError(
                "Choose an available custom emoji from this server.",
            );
        return emoji.toString();
    }
    const graphemes = [
        ...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            value,
        ),
    ];
    const emojiShape =
        /^(?:\p{Regional_Indicator}{2}|[0-9#*]\uFE0F?\u20E3|(?=\p{Extended_Pictographic})[\s\S]+)$/u;
    if (value.length > 100 || graphemes.length !== 1 || !emojiShape.test(value))
        throw new UserError(
            "Paste one emoji, such as ⭐, or a custom emoji from this server (or its ID).",
        );
    return value;
}

export function matchesStarboardEmoji(
    configured: string,
    emoji: { id: string | null; name: string | null },
): boolean {
    const id = customEmojiId(configured);
    return id
        ? emoji.id === id
        : emoji.id === null &&
              emoji.name?.replaceAll("\uFE0F", "") ===
                  configured.replaceAll("\uFE0F", "");
}

export async function validateStarboardSetup(
    guild: Guild,
    config: StarboardSettings,
): Promise<void> {
    if (!config.channel_id)
        throw new UserError("Choose a starboard channel before enabling it.");
    await starboardDestination(guild, config.channel_id);
    await starboardEmoji(guild, config.emoji);
    if (config.watch_channels?.length === 0)
        throw new UserError(
            "Choose watched channels or All accessible channels before enabling starboard.",
        );
    for (const id of config.watch_channels ?? [])
        await starboardSource(guild, id, config.channel_id);
}
