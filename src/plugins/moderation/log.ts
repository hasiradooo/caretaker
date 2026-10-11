import type { Guild } from "discord.js";
import type { Context } from "../../core/plugin";
import { sendableChannel } from "../../shared/discord";
import { card } from "../../shared/messages";

/** Record identifiers and outcomes, never repost the offending text, links or media. */
export async function moderationLog(
    context: Context,
    guild: Guild,
    channelId: string | null,
    title: string,
    body: string,
) {
    context.log.info(title, { guildId: guild.id, detail: body });
    if (!channelId) return;
    try {
        const channel = await sendableChannel(guild, channelId);
        await channel.send(
            card({
                title,
                icon: "🛡️",
                body,
                footer: "Automated moderation · No message content retained",
            }),
        );
    } catch (error) {
        context.log.warn(
            `Moderation log delivery failed for ${guild.id}`,
            error,
        );
    }
}
