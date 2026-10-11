import { createHash } from "node:crypto";
import {
    type Guild,
    type GuildTextBasedChannel,
    PermissionFlagsBits,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { card } from "../../shared/messages";
import { type TicketSettings, ticketsSchema } from "./config";
import { ticketLabel } from "./presentation";
import { TicketRepository, type TicketRow } from "./repository";
import { closeTicket } from "./service";

/** The longest role timeout wins; exemptions always take priority. */
async function policyFor(guild: Guild, row: TicketRow, config: TicketSettings) {
    if (!config.enabled || !config.auto_close.enabled) return null;
    // Permission/API failures must not accidentally bypass an exempt role.
    const member = await guild.members
        .fetch({ user: row.opener_id, force: true })
        .catch((error: unknown) => {
            if (
                error &&
                typeof error === "object" &&
                "code" in error &&
                error.code === 10007
            )
                return null;
            throw error;
        });
    if (
        config.role_time_limits.excluded.some((id) =>
            member?.roles.cache.has(id),
        )
    )
        return null;
    const custom = config.role_time_limits.included
        .filter((item) => member?.roles.cache.has(item.role_id))
        .map((item) => item.threshold_seconds * 1000);
    const threshold = custom.length
        ? Math.max(...custom)
        : config.auto_close.threshold_ms;
    // A short custom timeout can never have a warning period longer than itself.
    const lead = Math.min(config.auto_close.warning_ms, threshold);
    return { threshold, lead, key: `${threshold}:${lead}` };
}

/** Recover messages missed during downtime. Scan newest first, stopping at the
 * recorded activity. Never close when history cannot be checked completely. */
async function refreshActivity(
    repository: TicketRepository,
    guildId: string,
    channel: GuildTextBasedChannel,
    row: TicketRow,
    botId: string,
) {
    // Discord returns an empty list when Read Message History is missing. Check
    // it explicitly; an empty response alone is not proof of an idle thread.
    if (
        !channel
            .permissionsFor(botId)
            ?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ReadMessageHistory,
            ])
    )
        throw new Error(
            "Cannot verify ticket activity without View Channel and Read Message History.",
        );
    const activity = new Date(row.last_activity_at).getTime();
    let before: string | undefined;
    for (let page = 0; page < 100; page++) {
        const batch = await channel.messages.fetch({
            limit: 100,
            ...(before ? { before } : {}),
            cache: false,
        });
        const messages = [...batch.values()].sort(
            (a, b) => b.createdTimestamp - a.createdTimestamp,
        );
        for (const message of messages) {
            if (message.createdTimestamp <= activity) return;
            if (!message.author.bot && message.author.id === row.opener_id) {
                await repository.touch(
                    guildId,
                    row.thread_id,
                    row.opener_id,
                    new Date(message.createdTimestamp),
                );
                return;
            }
        }
        if (messages.length < 100) return;
        const oldest = messages.at(-1);
        if (!oldest || before === oldest.id) break;
        before = oldest.id;
    }
    throw new Error(
        "Ticket history could not be fully checked; automatic closure postponed.",
    );
}

/** Runs once per minute. Warning state lives in PostgreSQL, not a setTimeout,
 * so restarts do not lose deadlines or repeatedly notify the same member. */
export async function checkTicketInactivity(
    context: Context,
    guild: Guild,
    initial: TicketRow,
    config: TicketSettings,
    now: () => number = Date.now,
): Promise<void> {
    const repository = new TicketRepository(context.db, context.botId);
    const policy = await policyFor(guild, initial, config);
    if (!policy) {
        await repository.clearWarning(guild.id, initial.thread_id);
        return;
    }
    if (initial.inactivity_policy && initial.inactivity_policy !== policy.key)
        await repository.clearWarning(guild.id, initial.thread_id);
    if (
        now() <
        new Date(initial.last_activity_at).getTime() +
            policy.threshold -
            policy.lead
    )
        return;

    const channel = await guild.channels.fetch(initial.thread_id);
    if (!channel?.isTextBased())
        throw new Error("Cannot read ticket history for inactivity checks.");
    await refreshActivity(
        repository,
        guild.id,
        channel,
        initial,
        context.botId,
    );
    const row = await repository.get(guild.id, initial.thread_id);
    if (!row || row.status !== "open") return;
    const due = new Date(row.last_activity_at).getTime() + policy.threshold;
    if (now() < due - policy.lead) return;

    if (!row.inactivity_close_at) {
        // Discord's automatic thread archival is not ticket closure. Restore the
        // ongoing thread so the opener can receive the warning and reply to it.
        if (channel.isThread()) {
            if (channel.locked)
                await channel.setLocked(
                    false,
                    "Inactivity warning: allow the opener to reply",
                );
            if (channel.archived)
                await channel.setArchived(false, "Inactivity warning");
        }
        const warnedAt = now();
        // Late checks (including bot downtime) still give a full warning period.
        const deadline = Math.max(due, warnedAt + policy.lead);
        const unix = Math.ceil(deadline / 1000);
        const payload = card({
            icon: "⏳",
            title: `Ticket ${ticketLabel(row.ticket_number)} needs a reply`,
            body: `<@${row.opener_id}>, this ticket will close automatically <t:${unix}:R> (<t:${unix}:f>) because we haven't heard from you.`,
            sections: [
                "**Still need help?**\nSend a message in this thread before then to keep your ticket open and restart the inactivity timer.",
            ],
            footer: "Only your messages reset the timer · Staff can still close resolved tickets",
        });
        const nonce = createHash("sha256")
            .update(
                `${context.botId}:${guild.id}:${row.thread_id}:${row.last_activity_at}:${policy.key}`,
            )
            .digest("hex")
            .slice(0, 24);
        const warning = await channel.send({
            ...payload,
            allowedMentions: {
                parse: [],
                users: [row.opener_id],
                roles: [],
                repliedUser: false,
            },
            nonce,
            enforceNonce: true,
        });
        const saved = await repository.saveWarning(
            guild.id,
            row,
            policy.key,
            new Date(warnedAt),
            new Date(deadline),
            warning.id,
        );
        // If the opener replied during send(), remove the now-obsolete warning.
        if (!saved) await warning.delete().catch(() => {});
        return;
    }
    const closeAt = new Date(row.inactivity_close_at).getTime();
    if (now() < closeAt) return;

    await closeTicket(
        context,
        guild,
        row,
        config,
        context.botId,
        config.auto_close.reason,
        {
            expected: row,
            async check() {
                // Recheck after transcript capture AND after locking. A reply that arrives
                // while those API calls are in flight must keep the ticket open.
                await refreshActivity(
                    repository,
                    guild.id,
                    channel,
                    row,
                    context.botId,
                );
                const fresh = await repository.get(guild.id, row.thread_id);
                const settings = await context.settings.raw(
                    guild.id,
                    "tickets",
                );
                const currentConfig = ticketsSchema.parse({
                    ...settings.config,
                    enabled: settings.enabled,
                });
                const active =
                    fresh && (await policyFor(guild, fresh, currentConfig));
                return (
                    !!fresh &&
                    fresh.status === "open" &&
                    !!active &&
                    active.key === policy.key &&
                    fresh.inactivity_policy === policy.key &&
                    fresh.inactivity_close_at !== null &&
                    new Date(fresh.last_activity_at).getTime() ===
                        new Date(row.last_activity_at).getTime() &&
                    new Date(fresh.inactivity_close_at).getTime() === closeAt &&
                    now() >= new Date(fresh.inactivity_close_at).getTime()
                );
            },
        },
    );
}
