import {
    type CategoryChannel,
    ChannelType,
    type Guild,
    type OverwriteData,
    PermissionFlagsBits,
    PermissionsBitField,
    RESTJSONErrorCodes,
    Routes,
    type VoiceChannel,
} from "discord.js";
import type { Context } from "../../core/plugin";
import { UserError } from "../../shared/errors";
import { KeyedQueue } from "../../shared/serial";
import {
    counterName,
    type ServerStatsSettings,
    serverStatsSchema,
    statsUpdateMs,
} from "./config";
import { collectStats, requirePresenceAccess } from "./metrics";
import { type StatChannel, StatChannelRepository } from "./repository";

const reason = "Automatic server stats";
const botCounterPermissions =
    PermissionFlagsBits.ViewChannel |
    PermissionFlagsBits.Connect |
    PermissionFlagsBits.ManageChannels;
function accessError(error: unknown): boolean {
    return (
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        (error.code === RESTJSONErrorCodes.MissingAccess ||
            error.code === RESTJSONErrorCodes.MissingPermissions)
    );
}
function missingChannel(error: unknown): boolean {
    return (
        !!error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === RESTJSONErrorCodes.UnknownChannel
    );
}

export async function statsCategory(guild: Guild, id: string | null) {
    if (!id)
        throw new UserError("Choose a category for the stats channels first.");
    const category = await guild.channels
        .fetch(id, { force: true })
        .catch((error) => {
            if (accessError(error))
                throw new UserError(
                    `I cannot access the stats category <#${id}>. Allow me View Channel, Manage Channels and Manage Roles there, then try again.`,
                );
            if (missingChannel(error)) return null;
            throw error;
        });
    if (category?.type !== ChannelType.GuildCategory)
        throw new UserError("Choose an existing server category.");
    const me = guild.members.me ?? (await guild.members.fetchMe());
    if (
        !category
            .permissionsFor(me)
            ?.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ManageRoles,
            ]) ||
        !me.permissions.has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.ManageChannels,
            PermissionFlagsBits.ManageRoles,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.SendMessages,
        ])
    )
        throw new UserError(
            "My server role needs View Channel, Manage Channels, Manage Roles, Connect and Send Messages. View Channel, Manage Channels and Manage Roles must also be allowed in the stats category.",
        );
    return category;
}

export async function validateStatsSetup(
    context: Context,
    guild: Guild,
    config: ServerStatsSettings,
) {
    const category = await statsCategory(guild, config.category_id);
    if (!config.counters.length)
        throw new UserError(
            "Choose at least one counter before enabling stats.",
        );
    if (config.counters.includes("goal") && !config.member_goal)
        throw new UserError("Set a member goal for the Goal counter first.");
    for (const [kind, ids, label] of [
        ["supporters", config.supporter_role_ids, "supporter"],
        ["staff_online", config.staff_role_ids, "staff"],
    ] as const) {
        if (!config.counters.includes(kind)) continue;
        if (!ids.length)
            throw new UserError(`Choose the ${label} roles to count first.`);
        for (const id of ids) {
            const role = await guild.roles.fetch(id);
            if (!role || role.id === guild.id)
                throw new UserError(
                    `Choose existing ${label} roles other than @everyone.`,
                );
        }
    }
    if (config.counters.includes("staff_online"))
        requirePresenceAccess(context);
    return category;
}

/** Preserve category visibility, without copying Connect/Send overrides that
 * could accidentally make a counter joinable or open a private category. */
export function statsOverwrites(
    category: CategoryChannel,
    botId: string,
): OverwriteData[] {
    const view = PermissionFlagsBits.ViewChannel;
    const locked =
        PermissionFlagsBits.Connect | PermissionFlagsBits.SendMessages;
    const result = category.permissionOverwrites.cache.map((overwrite) => ({
        id: overwrite.id,
        type: overwrite.type,
        allow: overwrite.allow.bitfield & view,
        deny:
            (overwrite.deny.bitfield & view) |
            (overwrite.id === category.guild.id ? locked : 0n),
    }));
    if (!result.some((overwrite) => overwrite.id === category.guild.id))
        result.push({
            id: category.guild.id,
            type: 0,
            allow: 0n,
            deny: locked,
        });
    // Voice-channel access also needs Connect. The bot must retain access to
    // rename and repair its counters while ordinary members remain locked out.
    const own = result.find(
        (overwrite) => overwrite.id === botId && overwrite.type === 1,
    );
    if (own) {
        own.allow |= botCounterPermissions;
        own.deny &= ~botCounterPermissions;
    } else
        result.push({
            id: botId,
            type: 1,
            allow: botCounterPermissions,
            deny: 0n,
        });
    return result;
}

function sameOverwrites(
    channel: VoiceChannel,
    expected: OverwriteData[],
): boolean {
    const actual = channel.permissionOverwrites.cache.map((item) => ({
        id: item.id,
        type: item.type,
        allow: item.allow.bitfield.toString(),
        deny: item.deny.bitfield.toString(),
    }));
    const wanted = expected.map((item) => ({
        id: typeof item.id === "string" ? item.id : item.id.id,
        type: item.type ?? 0,
        allow: new PermissionsBitField(item.allow ?? 0n).bitfield.toString(),
        deny: new PermissionsBitField(item.deny ?? 0n).bitfield.toString(),
    }));
    const sort = (a: { id: string }, b: { id: string }) =>
        a.id.localeCompare(b.id);
    return (
        JSON.stringify(actual.sort(sort)) === JSON.stringify(wanted.sort(sort))
    );
}

export class ServerStatsService {
    private readonly queue = new KeyedQueue();
    constructor(private readonly now: () => number = Date.now) {}

    async sync(
        context: Context,
        guild: Guild,
        manual = false,
    ): Promise<string> {
        return this.queue.run(guild.id, async () => {
            const stored = await context.settings.raw(guild.id, "server_stats");
            const config = serverStatsSchema.parse({
                ...stored.config,
                enabled: stored.enabled,
            });
            if (!config.enabled)
                return "Stats are paused. Existing channels are kept.";
            if (
                !manual &&
                !(await context.state.claim(
                    guild.id,
                    "server_stats",
                    "refresh",
                    statsUpdateMs / 1000,
                ))
            )
                return "The next automatic update is not due yet.";
            try {
                const repository = new StatChannelRepository(
                    context.db,
                    context.botId,
                );
                const rows = await repository.list(guild.id);
                const current = async () => {
                    if (
                        (await context.settings.raw(guild.id, "server_stats"))
                            .revision !== stored.revision
                    )
                        throw new UserError(
                            "Stats settings changed during this update. Review them and try again.",
                        );
                };
                const fetch = async (
                    row: StatChannel,
                ): Promise<VoiceChannel | null> => {
                    if (!row.channel_id) {
                        const provisional = `stats-${row.creation_token}`;
                        const pending = (await guild.channels.fetch()).find(
                            (item) =>
                                item?.type === ChannelType.GuildVoice &&
                                item.name === provisional,
                        );
                        return pending
                            ? fetch({ ...row, channel_id: pending.id })
                            : null;
                    }
                    const channel = await guild.channels
                        .fetch(row.channel_id, { force: true })
                        .catch(async (error) => {
                            if (missingChannel(error)) return null;
                            if (accessError(error)) {
                                const message = `I cannot access my generated stats channel <#${row.channel_id}>. Allow Caretaker View Channel, Connect and Manage Channels on that channel, plus Manage Roles for editing its permissions, then retry Apply now.`;
                                const listed = (
                                    await guild.channels.fetch()
                                ).get(row.channel_id as string);
                                const me =
                                    guild.members.me ??
                                    (await guild.members.fetchMe());
                                if (
                                    listed?.type !== ChannelType.GuildVoice ||
                                    !me.permissions.has([
                                        botCounterPermissions,
                                        PermissionFlagsBits.ManageRoles,
                                    ])
                                )
                                    throw new UserError(message);
                                const own =
                                    listed.permissionOverwrites.cache.get(
                                        context.botId,
                                    );
                                await current();
                                try {
                                    await context.client.rest.put(
                                        Routes.channelPermission(
                                            listed.id,
                                            context.botId,
                                        ),
                                        {
                                            body: {
                                                type: 1,
                                                allow: (
                                                    (own?.allow.bitfield ??
                                                        0n) |
                                                    botCounterPermissions
                                                ).toString(),
                                                deny: (
                                                    (own?.deny.bitfield ?? 0n) &
                                                    ~botCounterPermissions
                                                ).toString(),
                                            },
                                            reason: "Restore bot access to its locked stats counter",
                                        },
                                    );
                                    return await guild.channels.fetch(
                                        listed.id,
                                        { force: true },
                                    );
                                } catch (repairError) {
                                    if (accessError(repairError))
                                        throw new UserError(message);
                                    throw repairError;
                                }
                            }
                            throw error;
                        });
                    if (channel && channel.type !== ChannelType.GuildVoice)
                        throw new UserError(
                            "A managed stats channel is no longer a voice channel. Remove it manually before regenerating that counter.",
                        );
                    return channel;
                };
                // Validate and read counts before changing any existing channels.
                const category = config.counters.length
                    ? await validateStatsSetup(context, guild, config)
                    : null;
                const counts = await collectStats(context, guild, config);
                await current();
                for (const row of rows.filter(
                    (row) => !config.counters.includes(row.counter),
                )) {
                    await current();
                    const channel = await fetch(row);
                    await current();
                    if (channel)
                        await channel.delete("Server stats counter deselected");
                    await repository.remove(guild.id, row.counter);
                }
                if (!category) return "Generated stats channels removed.";
                const overwrites = statsOverwrites(category, context.botId);
                let waiting = 0;
                for (const kind of config.counters) {
                    await current();
                    let row =
                        rows.find((row) => row.counter === kind) ??
                        (await repository.prepare(guild.id, kind));
                    let channel = await fetch(row);
                    if (channel && !row.channel_id)
                        await repository.attach(guild.id, kind, channel.id);
                    if (!channel) {
                        if (row.channel_id) {
                            await repository.remove(guild.id, kind);
                            row = await repository.prepare(guild.id, kind);
                        }
                        const provisional = `stats-${row.creation_token}`;
                        // A crash between Discord creation and saving its ID can
                        // be recovered by the unique provisional name.
                        await current();
                        channel = await guild.channels.create({
                            name: provisional,
                            type: ChannelType.GuildVoice,
                            parent: category.id,
                            permissionOverwrites: overwrites,
                            reason,
                        });
                        await repository.attach(guild.id, kind, channel.id);
                    }
                    const value = counts[kind];
                    if (value === undefined)
                        throw new UserError(
                            `The ${kind} count is unavailable. Try again shortly.`,
                        );
                    const name = counterName(kind, value);
                    const renameDue =
                        !row.renamed_at ||
                        this.now() - new Date(row.renamed_at).getTime() >=
                            statsUpdateMs;
                    if (
                        channel.parentId !== category.id ||
                        !sameOverwrites(channel, overwrites)
                    ) {
                        await current();
                        await channel.edit({
                            parent: category.id,
                            permissionOverwrites: overwrites,
                            reason,
                        });
                    }
                    if (channel.name !== name) {
                        if (renameDue) {
                            await current();
                            // Reserve the interval before the Discord request,
                            // so crashes and retries cannot repeatedly rename it.
                            await repository.reserveRename(
                                guild.id,
                                kind,
                                name,
                                new Date(this.now()),
                            );
                            await channel.setName(name, reason);
                        } else waiting++;
                    }
                }
                return `Stats channels updated.${waiting ? " Some name changes will apply after the ten-minute update interval." : ""}`;
            } catch (error) {
                if (!manual)
                    await context.state.release(
                        guild.id,
                        "server_stats",
                        "refresh",
                    );
                throw error;
            }
        });
    }
}
