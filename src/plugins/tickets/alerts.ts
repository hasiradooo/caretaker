import { RESTJSONErrorCodes, Routes } from "discord.js";
import type { Context } from "../../core/plugin";
import { TicketRepository, type TicketRow } from "./repository";

/** Delete only the saved alert, after closure has committed. Never touch the
 * transcript or thread. Retain the reference for audit and retry failed deletes. */
export async function removeClosedTicketAlert(
    context: Context,
    guildId: string,
    row: TicketRow,
): Promise<void> {
    if (
        row.status !== "closed" ||
        row.staff_alert_deleted_at ||
        !row.staff_alert_channel_id ||
        !row.staff_alert_message_id
    )
        return;
    try {
        try {
            await context.client.rest.delete(
                Routes.channelMessage(
                    row.staff_alert_channel_id,
                    row.staff_alert_message_id,
                ),
            );
        } catch (error) {
            // A moderator may already have removed the message or the entire channel.
            if (
                !(
                    error instanceof Error &&
                    "code" in error &&
                    (error.code === RESTJSONErrorCodes.UnknownMessage ||
                        error.code === RESTJSONErrorCodes.UnknownChannel)
                )
            )
                throw error;
        }
        await new TicketRepository(
            context.db,
            context.botId,
        ).markStaffAlertDeleted(guildId, row);
    } catch (error) {
        // The minute task retries from the durable record. Deletion failure must not
        // turn a successfully closed ticket back into an ongoing one.
        context.log.warn(
            `Could not remove staff alert for ticket ${row.thread_id}; will retry`,
            error,
        );
    }
}
