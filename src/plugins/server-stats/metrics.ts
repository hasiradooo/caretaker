import { GatewayIntentBits, type Guild, type GuildMember } from "discord.js";
import type { Context } from "../../core/plugin";
import { UserError } from "../../shared/errors";
import type { CounterKind, ServerStatsSettings } from "./config";

export function requirePresenceAccess(context: Context): void {
    if (!context.client.options.intents.has(GatewayIntentBits.GuildPresences))
        throw new UserError(
            "Staff online needs Presence access. The bot owner must enable Presence Intent in Discord, set DISCORD_PRESENCES_ENABLED=true, and restart the bot.",
        );
}

/** Paginate rather than interpreting a partially populated cache as a total. */
async function members(
    guild: Guild,
    presences: boolean,
): Promise<GuildMember[]> {
    if (presences)
        return [
            ...(
                await guild.members.fetch({ withPresences: true, time: 30000 })
            ).values(),
        ];
    const found = new Map<string, GuildMember>();
    let after: string | undefined;
    for (;;) {
        const page = await guild.members.list({
            limit: 1000,
            after,
            cache: false,
        });
        for (const member of page.values()) found.set(member.id, member);
        if (page.size < 1000) break;
        const next = page.last()?.id;
        if (!next || (after && BigInt(next) <= BigInt(after)))
            throw new UserError(
                "I could not read the complete member list. Try again shortly.",
            );
        after = next;
    }
    return [...found.values()];
}

export async function collectStats(
    context: Context,
    guild: Guild,
    config: ServerStatsSettings,
): Promise<Partial<Record<CounterKind, number>>> {
    const values: Partial<Record<CounterKind, number>> = {
        members: guild.memberCount,
        goal: config.member_goal ?? undefined,
        boosts: guild.premiumSubscriptionCount ?? 0,
    };
    const presence = config.counters.includes("staff_online");
    if (presence) requirePresenceAccess(context);
    if (
        config.counters.some((kind) =>
            ["humans", "bots", "supporters", "staff_online"].includes(kind),
        )
    ) {
        const roster = await members(guild, presence);
        const humans = roster.filter((member) => !member.user.bot);
        values.humans = humans.length;
        values.bots = roster.length - humans.length;
        values.supporters = humans.filter((member) =>
            config.supporter_role_ids.some((id) => member.roles.cache.has(id)),
        ).length;
        values.staff_online = humans.filter(
            (member) =>
                config.staff_role_ids.some((id) =>
                    member.roles.cache.has(id),
                ) &&
                ["online", "idle", "dnd"].includes(
                    member.presence?.status ?? "offline",
                ),
        ).length;
    }
    return values;
}
