import {
    type AnyThreadChannel,
    ChannelType,
    type Message,
    PermissionFlagsBits,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { sendableChannel } from "../../shared/discord";
import type { KeyedQueue } from "../../shared/serial";
import { starboardSchema } from "./config";
import { matchesStarboardEmoji } from "./setup";
import { canShareStarboardSource, watchesStarboardSource } from "./sources";

export function starboardAutoReactions(context: Context, queue: KeyedQueue) {
    async function message(input: Message): Promise<void> {
        if (
            !input.inGuild() ||
            input.author.bot ||
            input.system ||
            input.webhookId
        )
            return;
        await queue.run(`${input.guildId}:${input.id}`, async () => {
            // Read inside the queue so a pause/channel edit applies to queued work too.
            const config = await context.settings.get(
                input.guildId,
                "starboard",
                starboardSchema,
            );
            if (
                !config.enabled ||
                !config.auto_react ||
                !config.channel_id ||
                !(await watchesStarboardSource(input, config))
            )
                return;
            if (
                input.channel.isThread() &&
                (input.channel.archived || input.channel.locked)
            )
                return;
            if (
                input.reactions.cache.some(
                    (reaction) =>
                        reaction.me &&
                        matchesStarboardEmoji(config.emoji, reaction.emoji),
                )
            )
                return;
            const me =
                input.guild.members.me ?? (await input.guild.members.fetchMe());
            if (
                !input.channel
                    .permissionsFor(me)
                    ?.has([
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.AddReactions,
                    ])
            ) {
                context.log.debug(
                    "Starboard auto-reaction skipped: missing channel permissions",
                    {
                        guildId: input.guildId,
                        channelId: input.channelId,
                    },
                );
                return;
            }
            try {
                const target = await sendableChannel(
                    input.guild,
                    config.channel_id,
                );
                if (!canShareStarboardSource(input.channel, target)) return;
                // Discord's reaction PUT is idempotent, including overlapping gateway events.
                await input.react(config.emoji);
            } catch (error) {
                // Moderation can delete a message before the reaction request completes.
                if (
                    error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === 10008
                )
                    return;
                context.log.warn(
                    `Starboard auto-reaction failed in channel ${input.channelId} for message ${input.id}`,
                    error,
                );
            }
        });
    }

    async function thread(
        input: AnyThreadChannel,
        newlyCreated: boolean,
    ): Promise<void> {
        // A forum/media post arrives as a new thread. Never scan threads discovered
        // on restart or when the bot is added to an existing thread.
        if (
            !newlyCreated ||
            !input.parent ||
            ![ChannelType.GuildForum, ChannelType.GuildMedia].includes(
                input.parent.type,
            )
        )
            return;
        const config = await context.settings.get(
            input.guildId,
            "starboard",
            starboardSchema,
        );
        if (
            !config.enabled ||
            !config.auto_react ||
            !config.channel_id ||
            !(await watchesStarboardSource(
                { channel: input, channelId: input.id, guild: input.guild },
                config,
            ))
        )
            return;
        try {
            const starter = await input.fetchStarterMessage();
            if (starter) await message(starter);
        } catch (error) {
            if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === 10008
            )
                return;
            context.log.warn(
                `Starboard could not read the new post in thread ${input.id}`,
                error,
            );
        }
    }

    return { message, thread };
}
