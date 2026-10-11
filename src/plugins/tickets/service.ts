import { ChannelType, type Guild } from "discord.js";
import type { Context } from "../../core/plugin";

import { UserError } from "../../shared/errors";

import { isTicketStaff } from "./access";
import { removeClosedTicketAlert } from "./alerts";
import type { TicketSettings } from "./config";

import { TicketRepository, type TicketRow } from "./repository";
import { requestTicketReview } from "./reviews";
import { prepareTicketTranscript, syncTicketTranscript } from "./transcripts";

export { isTicketStaff } from "./access";
export { openTicket } from "./opening";

export async function closeTicket(
    context: Context,
    guild: Guild,
    row: TicketRow,
    config: TicketSettings,
    closerId: string,
    reason: string,
    inactivity?: { expected: TicketRow; check(): Promise<boolean> },
): Promise<void> {
    // Keep authorization here too, so future buttons cannot bypass the command
    // check. Only the scheduler may close on behalf of this bot application.
    if (closerId !== context.botId) {
        const closer = await guild.members.fetch({
            user: closerId,
            force: true,
        });
        if (!isTicketStaff(closer, config))
            throw new UserError("Only ticket staff can close tickets.");
    }
    const claimKey = `close:${row.thread_id}`;
    if (!(await context.state.claim(guild.id, "tickets", claimKey, 300)))
        throw new UserError("This ticket is already being closed.");
    try {
        const current = await new TicketRepository(
            context.db,
            context.botId,
        ).get(guild.id, row.thread_id);
        if (!current) return;
        if (current.status === "closed") {
            await removeClosedTicketAlert(context, guild.id, current);
            await syncTicketTranscript(context, guild.id, row.thread_id);
            return;
        }

        const channel = await guild.channels.fetch(row.thread_id);
        if (!channel || !channel.isTextBased())
            throw new UserError("The ticket channel no longer exists.");
        if (config.transcript_channel_id) {
            await prepareTicketTranscript(
                context,
                guild,
                channel,
                current,
                config.transcript_channel_id,
                closerId,
                reason,
            );
        }
        if (inactivity && !(await inactivity.check())) return;
        let closed = false;
        try {
            if (channel.type === ChannelType.GuildText) {
                await channel.permissionOverwrites.edit(
                    row.opener_id,
                    { SendMessages: false },
                    { reason },
                );
                await channel.setName(
                    `closed-${channel.name.replace(/^ticket-/, "").slice(0, 80)}`,
                );
            } else if (channel.isThread()) {
                await channel.setLocked(true, reason);
                await channel.setArchived(true, reason);
            } else throw new UserError("Unsupported ticket channel type.");
            if (inactivity && !(await inactivity.check())) return;
            closed = await new TicketRepository(
                context.db,
                context.botId,
            ).close(
                guild.id,
                row.thread_id,
                closerId,
                reason,
                inactivity?.expected,
            );
        } finally {
            // A last-second reply (or failed history check) cancels automatic closure.
            // Restore access before returning; no transcript/review is published.
            if (inactivity && !closed) {
                if (channel.isThread()) {
                    await channel.setLocked(
                        false,
                        "Automatic closure cancelled",
                    );
                    await channel.setArchived(
                        false,
                        "The ticket is still ongoing",
                    );
                } else if (channel.type === ChannelType.GuildText) {
                    await channel.permissionOverwrites.edit(row.opener_id, {
                        SendMessages: true,
                    });
                    await channel.setName(
                        channel.name.replace(/^closed-/, "ticket-"),
                    );
                }
            }
        }
        if (!closed) return;
        await removeClosedTicketAlert(context, guild.id, {
            ...current,
            status: "closed",
        });
        await syncTicketTranscript(context, guild.id, row.thread_id);
        await requestTicketReview(context, guild, row.thread_id);
    } finally {
        await context.state.release(guild.id, "tickets", claimKey);
    }
}
