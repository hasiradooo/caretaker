import {
    type Guild,
    RESTJSONErrorCodes,
    type TextBasedChannel,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { UserError } from "../../shared/errors";
import { componentText } from "../../shared/messages";
import { KeyedQueue } from "../../shared/serial";
import type { TicketRow } from "./repository";
import { ticketDestination } from "./setup";
import { transcriptPayload } from "./transcript-presentation";
import {
    type TranscriptMessage,
    TranscriptRepository,
    type TranscriptSnapshot,
} from "./transcript-repository";

/** V2 file/gallery uploads can live in components instead of message.attachments. */
function componentFiles(value: unknown): { name: string; url: string }[] {
    if (!value || typeof value !== "object") return [];
    if ("toJSON" in value && typeof value.toJSON === "function")
        return componentFiles(value.toJSON());
    const item = value as {
        type?: number;
        file?: { url?: string };
        items?: { media?: { url?: string }; description?: string }[];
        components?: unknown[];
    };
    const result = (item.components ?? []).flatMap(componentFiles);
    if (item.type === 13 && item.file?.url) {
        let name = "Attachment";
        try {
            name = decodeURIComponent(
                new URL(item.file.url).pathname.split("/").at(-1) ?? name,
            );
        } catch {
            /* Preserve the URL as text if it is malformed. */
        }
        result.push({ name, url: item.file.url });
    }
    if (item.type === 12)
        for (const media of item.items ?? []) {
            if (media.media?.url)
                result.push({
                    name: media.description ?? "Shared image",
                    url: media.media.url,
                });
        }
    return result;
}

export async function captureTranscript(
    guild: Guild,
    channel: TextBasedChannel,
    ticket: TicketRow,
    closerId: string,
): Promise<TranscriptSnapshot> {
    const messages: TranscriptMessage[] = [];
    let before: string | undefined,
        complete = false;
    // Capture once. Rating updates must not depend on mutable/deleted thread history.
    for (let page = 0; page < 100; page++) {
        const batch = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {}),
        });
        for (const message of batch.values()) {
            messages.push({
                id: message.id,
                author_id: message.author.id,
                author_name:
                    message.member?.displayName ??
                    message.author.globalName ??
                    message.author.username,
                created_at: message.createdAt.toISOString(),
                edited_at: message.editedAt?.toISOString() ?? null,
                reply_to: message.reference?.messageId ?? null,
                text: [
                    message.content,
                    ...message.components.map(componentText),
                    ...message.embeds.flatMap((embed) => [
                        embed.title,
                        embed.description,
                        ...embed.fields.map(
                            (field) => `${field.name}\n${field.value}`,
                        ),
                    ]),
                    ...message.stickers.map(
                        (sticker) => `Sticker: ${sticker.name}`,
                    ),
                ]
                    .filter(Boolean)
                    .join("\n"),
                attachments: [
                    ...new Map(
                        [
                            ...message.attachments.map((a) => ({
                                name: a.name,
                                url: a.url,
                            })),
                            ...message.components.flatMap(componentFiles),
                        ].map((a) => [a.url, a]),
                    ).values(),
                ],
            });
        }
        if (batch.size < 100) {
            complete = true;
            break;
        }
        before = batch.last()?.id;
    }
    messages.reverse();
    const names: Record<string, string> = Object.fromEntries(
        messages.map((m) => [m.author_id, m.author_name]),
    );
    for (const id of new Set(
        [ticket.opener_id, ticket.claimed_by, closerId].filter(
            (id): id is string => Boolean(id),
        ),
    )) {
        const member = await guild.members
            .fetch({ user: id })
            .catch(() => null);
        names[id] =
            member?.displayName ??
            member?.user.globalName ??
            member?.user.username ??
            names[id] ??
            id;
    }
    return { server_name: guild.name, names, complete, messages };
}

export async function prepareTicketTranscript(
    context: Context,
    guild: Guild,
    channel: TextBasedChannel,
    ticket: TicketRow,
    channelId: string,
    closerId: string,
    reason: string,
): Promise<void> {
    if (channel.id === channelId)
        throw new UserError(
            "Ticket transcripts need a separate staff-only channel.",
        );
    await ticketDestination(guild, channelId, true);
    const snapshot = await captureTranscript(guild, channel, ticket, closerId);
    const repository = new TranscriptRepository(context.db, context.botId);
    await repository.prepare(guild.id, ticket.thread_id, channelId, snapshot);
    const row = await repository.get(guild.id, ticket.thread_id);
    if (!row) throw new Error("Transcript snapshot was not saved.");
    // Fail an oversized export before closing the room. Allow headroom for review text.
    transcriptPayload({
        ...row,
        closed_by: closerId,
        close_reason: reason,
        closed_at: new Date(),
        rating: 5,
        reviewed_at: new Date(),
    });
}

const publishing = new KeyedQueue();
/** Same message and attachments are edited after a review. The database tracks
 * the published version so failed updates resume on the next minute/restart. */
export async function syncTicketTranscript(
    context: Context,
    guildId: string,
    threadId: string,
): Promise<void> {
    await publishing.run(
        `${context.botId}:${guildId}:${threadId}`,
        async () => {
            try {
                const repository = new TranscriptRepository(
                    context.db,
                    context.botId,
                );
                const row = await repository.get(guildId, threadId);
                if (
                    !row ||
                    row.status !== "closed" ||
                    (row.published_revision === row.revision &&
                        row.published_rating === row.rating)
                )
                    return;
                const guild = await context.client.guilds.fetch(guildId);
                // Recheck privacy every time, using the original saved destination.
                const target = await ticketDestination(
                    guild,
                    row.channel_id,
                    true,
                );
                const payload = transcriptPayload(row);
                let messageId = row.message_id;
                if (messageId) {
                    try {
                        await target.messages.edit(messageId, {
                            ...payload,
                            attachments: [],
                        });
                    } catch (error) {
                        if (
                            !(
                                error instanceof Error &&
                                "code" in error &&
                                error.code === RESTJSONErrorCodes.UnknownMessage
                            )
                        )
                            throw error;
                        context.log.warn(
                            `Transcript message for ${threadId} was deleted; it will not be recreated`,
                        );
                    }
                } else {
                    const sent = await target.send({
                        ...payload,
                        nonce: `ta-${threadId}`,
                        enforceNonce: true,
                    });
                    messageId = sent.id;
                }
                await repository.published(row, messageId);
            } catch (error) {
                context.log.warn(
                    `Could not update transcript for ${threadId}; will retry`,
                    error,
                );
            }
        },
    );
}
