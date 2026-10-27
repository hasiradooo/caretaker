import { afterAll, beforeAll, expect, type Mock, mock, test } from "bun:test";
import {
    ChannelType,
    type ChatInputCommandInteraction,
    Collection,
    ComponentType,
    GatewayIntentBits,
    type Guild,
    type GuildMember,
    IntentsBitField,
    type Interaction,
    MessageFlags,
    type OverwriteData,
    PermissionFlagsBits,
    PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { StateStore } from "../src/database/state-store";
import { createServerStatsPlugin } from "../src/plugins/server-stats";
import {
    counterName,
    serverStatsSchema,
    statsUpdateMs,
} from "../src/plugins/server-stats/config";
import { collectStats } from "../src/plugins/server-stats/metrics";
import { StatChannelRepository } from "../src/plugins/server-stats/repository";
import { ServerStatsService } from "../src/plugins/server-stats/service";
import { ServerStatsSettingsEditor } from "../src/plugins/server-stats/settings-editor";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

let db: Database;
let sequence = 0;
const botId = "100000000000000001",
    userId = "300000000000000001";
const categoryId = "400000000000000001",
    otherCategoryId = "400000000000000002";
const supporterA = "500000000000000001",
    supporterB = "500000000000000002",
    staffId = "500000000000000003";
beforeAll(async () => {
    db = await testDatabase();
}, 30000);
afterAll(async () => {
    await db?.close();
});
type Overwrite = {
    id: string;
    type: 0 | 1;
    allow: PermissionsBitField;
    deny: PermissionsBitField;
};
type Voice = {
    id: string;
    type: ChannelType.GuildVoice;
    name: string;
    parentId: string;
    permissionOverwrites: { cache: Collection<string, Overwrite> };
    setName: Mock<(name: string, reason?: string) => Promise<void>>;
    edit: Mock<
        (options: {
            parent: string;
            permissionOverwrites: OverwriteData[];
            reason?: string;
        }) => Promise<void>
    >;
    delete: Mock<(reason?: string) => Promise<void>>;
};
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
function controls(payload: unknown) {
    return wire(payload).components.flatMap(
        (item: { components?: { custom_id?: string }[] }) =>
            item.components ?? [],
    );
}
function actionId(payload: unknown, action: string): string {
    const id = controls(payload).find((item: { custom_id?: string }) =>
        item.custom_id?.endsWith(`:${action}`),
    )?.custom_id;
    if (!id) throw new Error(`Missing action ${action}`);
    return id;
}

async function fixture(patch: Record<string, unknown> = {}, presence = false) {
    const guildId = String(200000000000000000n + BigInt(++sequence));
    const settings = new SettingsStore(db, botId);
    await settings.patch(guildId, "server_stats", serverStatsSchema, {
        enabled: true,
        category_id: categoryId,
        counters: ["members"],
        custom_note: "Keep me",
        ...patch,
    });
    let clock = Date.now();
    let nextChannel = 0;
    const full = new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ManageChannels,
        PermissionFlagsBits.ManageRoles,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.SendMessages,
    ]);
    const channels = new Collection<string, unknown>();
    const roster = new Collection<string, GuildMember>();
    const created: Voice[] = [];
    const accessible = (voice: Voice): boolean => {
        const everyone = voice.permissionOverwrites.cache.get(guildId);
        const own = voice.permissionOverwrites.cache.get(botId);
        const bits =
            (((full.bitfield & ~(everyone?.deny.bitfield ?? 0n)) |
                (everyone?.allow.bitfield ?? 0n)) &
                ~(own?.deny.bitfield ?? 0n)) |
            (own?.allow.bitfield ?? 0n);
        return new PermissionsBitField(bits).has([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
            PermissionFlagsBits.ManageChannels,
        ]);
    };
    const overwrites = (items: OverwriteData[]) =>
        new Collection<string, Overwrite>(
            items.map((item) => {
                const id = typeof item.id === "string" ? item.id : item.id.id;
                return [
                    id,
                    {
                        id,
                        type: (item.type ?? 0) as 0 | 1,
                        allow: new PermissionsBitField(item.allow ?? 0n),
                        deny: new PermissionsBitField(item.deny ?? 0n),
                    },
                ];
            }),
        );
    const makeVoice = (
        name: string,
        parent = categoryId,
        permissions: OverwriteData[] = [],
    ): Voice => {
        const voice: Voice = {
            id: String(600000000000000000n + BigInt(++nextChannel)),
            type: ChannelType.GuildVoice,
            name,
            parentId: parent,
            permissionOverwrites: { cache: overwrites(permissions) },
            setName: mock(async (name) => {
                if (!accessible(voice))
                    throw Object.assign(new Error("Missing Access"), {
                        code: 50001,
                    });
                voice.name = name;
            }),
            edit: mock(async (options) => {
                voice.parentId = options.parent;
                voice.permissionOverwrites.cache = overwrites(
                    options.permissionOverwrites,
                );
            }),
            delete: mock(async () => {
                channels.delete(voice.id);
            }),
        };
        channels.set(voice.id, voice);
        return voice;
    };
    const guild = {
        id: guildId,
        memberCount: 12,
        premiumSubscriptionCount: 3,
        members: {
            me: { id: botId, permissions: full },
            list: mock(
                async (_options: {
                    limit: number;
                    after?: string;
                    cache: boolean;
                }) => new Collection(roster),
            ),
            fetch: mock(async (_options: unknown) => new Collection(roster)),
        },
        roles: {
            fetch: mock(async (id: string) =>
                [supporterA, supporterB, staffId, guildId].includes(id)
                    ? { id }
                    : null,
            ),
        },
        channels: {
            fetch: mock(async (id?: string, _options?: { force?: boolean }) => {
                if (!id) return new Collection(channels);
                const channel = channels.get(id);
                if (
                    channel &&
                    typeof channel === "object" &&
                    "type" in channel &&
                    channel.type === ChannelType.GuildVoice &&
                    !accessible(channel as Voice)
                )
                    throw Object.assign(new Error("Missing Access"), {
                        code: 50001,
                    });
                return channel ?? null;
            }),
            create: mock(
                async (options: {
                    name: string;
                    parent: string;
                    permissionOverwrites: OverwriteData[];
                }) => {
                    const voice = makeVoice(
                        options.name,
                        options.parent,
                        options.permissionOverwrites,
                    );
                    created.push(voice);
                    return voice;
                },
            ),
        },
    };
    const category = {
        id: categoryId,
        guild,
        type: ChannelType.GuildCategory,
        permissionsFor: mock(() => full),
        permissionOverwrites: { cache: new Collection<string, Overwrite>() },
    };
    channels.set(categoryId, category);
    const context = {
        botId,
        db,
        settings,
        state: new StateStore(db, botId),
        client: {
            options: {
                intents: new IntentsBitField([
                    GatewayIntentBits.GuildMembers,
                    ...(presence ? [GatewayIntentBits.GuildPresences] : []),
                ]),
            },
            guilds: { cache: new Collection([[guildId, guild]]) },
        },
        log: { warn: mock(() => {}) },
    } as unknown as Context;
    const service = new ServerStatsService(() => clock);
    const repository = new StatChannelRepository(db, botId);
    const config = () =>
        settings.get(guildId, "server_stats", serverStatsSchema);
    const sync = (manual = true) =>
        service.sync(context, guild as unknown as Guild, manual);
    const member = (
        id: string,
        roles: string[] = [],
        bot = false,
        status = "offline",
    ) => {
        const item = {
            id,
            user: { bot },
            roles: { cache: new Collection(roles.map((id) => [id, { id }])) },
            presence: { status },
        } as unknown as GuildMember;
        roster.set(id, item);
        return item;
    };
    let payload: unknown;
    const editor = new ServerStatsSettingsEditor(service, () => clock);
    const base = {
        guildId,
        guild,
        user: { id: userId },
        member: { id: userId },
        memberPermissions: new PermissionsBitField(
            PermissionFlagsBits.ManageGuild,
        ),
        editReply: mock(async (value: unknown) => {
            payload = value;
        }),
    };
    const open = () =>
        editor.open(
            context,
            base as unknown as ChatInputCommandInteraction<"cached">,
        );
    const event = (
        customId: string,
        type = "button",
        values: string[] = [],
        overrides = {},
    ) => ({
        ...base,
        customId,
        values,
        message: { author: { id: botId } },
        isMessageComponent: () => type !== "modal",
        isModalSubmit: () => type === "modal",
        isFromMessage: () => true,
        isButton: () => type === "button",
        isChannelSelectMenu: () => type === "channel",
        isStringSelectMenu: () => type === "string",
        isRoleSelectMenu: () => type === "role",
        deferUpdate: mock(async () => {}),
        showModal: mock(async (_modal: unknown) => {}),
        ...overrides,
    });
    const handle = (item: ReturnType<typeof event>) =>
        editor.handle(context, item as unknown as Interaction<"cached">);
    const act = async (
        action: string,
        type = "button",
        values: string[] = [],
    ) => {
        const item = event(actionId(payload, action), type, values);
        await handle(item);
        const json = wire(payload);
        expect(json.flags).toBe(MessageFlags.IsComponentsV2);
        expect(componentText(json).length).toBeLessThanOrEqual(4000);
        expect(
            json.components.filter(
                (item: { type: number }) =>
                    item.type === ComponentType.ActionRow,
            ).length,
        ).toBeLessThanOrEqual(3);
        return item;
    };
    return {
        guild,
        guildId,
        context,
        settings,
        config,
        sync,
        service,
        repository,
        channels,
        category,
        created,
        makeVoice,
        roster,
        member,
        full,
        editor,
        base,
        open,
        event,
        handle,
        act,
        payload: () => payload,
        advance: (ms: number) => {
            clock += ms;
        },
        freshService: () => new ServerStatsService(() => clock),
    };
}

test("stats defaults are disabled and only known, unique counters and positive goals are accepted", () => {
    expect(serverStatsSchema.parse({})).toMatchObject({
        enabled: false,
        category_id: null,
        counters: ["members"],
        separators: {},
    });
    for (const config of [
        { counters: ["members", "members"] },
        { counters: ["unknown"] },
        { member_goal: 0 },
        { member_goal: 1.5 },
        { separators: { unknown: "|" } },
        { separators: { members: " " } },
        { separators: { members: "x".repeat(17) } },
        { separators: { members: "|\n・" } },
        { separators: { members: "|\u0000" } },
    ])
        expect(serverStatsSchema.safeParse(config).success).toBe(false);
    expect(counterName("members", 12)).toBe("💚 ┃ Members: 12");
    expect(
        serverStatsSchema.parse({
            separators: { members: " | ", boosts: "・" },
        }).separators,
    ).toEqual({ members: "|", boosts: "・" });
});

test("aggregate-only counters do not fetch the member roster", async () => {
    const f = await fixture({
        counters: ["members", "goal", "boosts"],
        member_goal: 30000,
    });
    const counts = await collectStats(
        f.context,
        f.guild as unknown as Guild,
        await f.config(),
    );
    expect(counts).toMatchObject({ members: 12, goal: 30000, boosts: 3 });
    expect(f.guild.members.list).not.toHaveBeenCalled();
    expect(f.guild.members.fetch).not.toHaveBeenCalled();
});

test("humans and bots use complete pages, while overlapping supporter roles count each human once", async () => {
    const f = await fixture({
        counters: ["humans", "bots", "supporters"],
        supporter_role_ids: [supporterA, supporterB],
    });
    for (let i = 0; i < 1001; i++)
        f.member(
            String(700000000000000000n + BigInt(i)),
            i < 2 ? [supporterA, supporterB] : [],
            i === 1000,
        );
    const all = [...f.roster.values()];
    f.guild.members.list.mockImplementation(
        async (options) =>
            new Collection(
                (options.after ? all.slice(1000) : all.slice(0, 1000)).map(
                    (member) => [member.id, member],
                ),
            ),
    );
    const values = await collectStats(
        f.context,
        f.guild as unknown as Guild,
        await f.config(),
    );
    expect(values).toMatchObject({ humans: 1000, bots: 1, supporters: 2 });
    expect(f.guild.members.list.mock.calls[1]?.[0].after).toBe(all[999]?.id);
});

test("online staff excludes bots and offline/invisible users and requires presence access", async () => {
    const f = await fixture(
        { counters: ["staff_online"], staff_role_ids: [staffId] },
        true,
    );
    ["online", "idle", "dnd", "offline"].forEach((status, i) => {
        f.member(
            String(700000000000000000n + BigInt(i)),
            [staffId],
            false,
            status,
        );
    });
    f.member("700000000000000010", [staffId], true, "online");
    f.member("700000000000000011", [], false, "online");
    expect(
        (
            await collectStats(
                f.context,
                f.guild as unknown as Guild,
                await f.config(),
            )
        ).staff_online,
    ).toBe(3);
    expect(f.guild.members.fetch).toHaveBeenCalledWith({
        withPresences: true,
        time: 30000,
    });
    const denied = await fixture({
        counters: ["staff_online"],
        staff_role_ids: [staffId],
    });
    await expect(denied.sync()).rejects.toThrow("Presence");
    expect(denied.created).toHaveLength(0);
});

test("generated voice counters preserve private visibility and cannot inherit join/chat overrides", async () => {
    const f = await fixture({
        counters: ["members", "goal"],
        member_goal: 30000,
    });
    f.category.permissionOverwrites.cache.set(f.guildId, {
        id: f.guildId,
        type: 0,
        allow: new PermissionsBitField(),
        deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
    });
    f.category.permissionOverwrites.cache.set(staffId, {
        id: staffId,
        type: 0,
        allow: new PermissionsBitField([
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.Connect,
        ]),
        deny: new PermissionsBitField(),
    });
    const unrelated = f.makeVoice("My voice room");
    await f.sync();
    expect(f.created.map((channel) => channel.name)).toEqual([
        counterName("members", 12),
        counterName("goal", 30000),
    ]);
    for (const channel of f.created) {
        expect(channel.parentId).toBe(categoryId);
        const everyone = channel.permissionOverwrites.cache.get(f.guildId);
        expect(
            everyone?.deny.has([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.SendMessages,
            ]),
        ).toBe(true);
        expect(
            channel.permissionOverwrites.cache
                .get(staffId)
                ?.allow.has(PermissionFlagsBits.Connect),
        ).toBe(false);
        expect(
            channel.permissionOverwrites.cache
                .get(botId)
                ?.allow.has([
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.Connect,
                    PermissionFlagsBits.ManageChannels,
                ]),
        ).toBe(true);
        expect(
            channel.permissionOverwrites.cache
                .get(botId)
                ?.allow.has(PermissionFlagsBits.Administrator, false),
        ).toBe(false);
    }
    expect(unrelated.delete).not.toHaveBeenCalled();
});

test("concurrent refreshes and process restarts reuse channels and preserve the rename interval", async () => {
    const f = await fixture();
    await Promise.all([f.sync(), f.sync(), f.sync()]);
    expect(f.created).toHaveLength(1);
    const channel = f.created[0];
    expect(channel?.setName).toHaveBeenCalledTimes(1);
    f.guild.memberCount = 13;
    f.advance(statsUpdateMs - 1);
    await f.freshService().sync(f.context, f.guild as unknown as Guild, true);
    expect(channel?.name).toBe(counterName("members", 12));
    f.advance(1);
    await f.sync();
    expect(channel?.name).toBe(counterName("members", 13));
    expect(channel?.setName).toHaveBeenCalledTimes(2);
    expect(f.created).toHaveLength(1);
});

test("pausing retains counters, and deselecting removes only this bot's generated channels", async () => {
    const f = await fixture();
    const unrelated = f.makeVoice("An existing room");
    await f.sync();
    await f.settings.patch(f.guildId, "server_stats", serverStatsSchema, {
        enabled: false,
    });
    await f.sync();
    expect(f.created[0]?.delete).not.toHaveBeenCalled();
    await f.settings.patch(f.guildId, "server_stats", serverStatsSchema, {
        enabled: true,
        counters: [],
    });
    await f.sync();
    expect(f.created[0]?.delete).toHaveBeenCalledTimes(1);
    expect(unrelated.delete).not.toHaveBeenCalled();
    expect(await f.repository.list(f.guildId)).toEqual([]);
});

test("category changes move the existing counters and same-category visibility edits are applied", async () => {
    const f = await fixture();
    await f.sync();
    const category = {
        ...f.category,
        id: otherCategoryId,
        permissionOverwrites: { cache: new Collection<string, Overwrite>() },
    };
    f.channels.set(otherCategoryId, category);
    await f.settings.patch(f.guildId, "server_stats", serverStatsSchema, {
        category_id: otherCategoryId,
    });
    await f.sync();
    const voice = f.created[0];
    expect(voice?.parentId).toBe(otherCategoryId);
    category.permissionOverwrites.cache.set(f.guildId, {
        id: f.guildId,
        type: 0,
        allow: new PermissionsBitField(),
        deny: new PermissionsBitField(PermissionFlagsBits.ViewChannel),
    });
    await f.sync();
    expect(
        voice?.permissionOverwrites.cache
            .get(f.guildId)
            ?.deny.has(PermissionFlagsBits.ViewChannel),
    ).toBe(true);
    expect(voice?.setName).toHaveBeenCalledTimes(1);
    expect(f.created).toHaveLength(1);
});

test("inaccessible counters are not mistaken for deleted channels, while deleted counters are recreated", async () => {
    const f = await fixture();
    await f.sync();
    const id = f.created[0]?.id;
    if (!id) throw new Error("Missing counter");
    const fetch = f.guild.channels.fetch.getMockImplementation();
    if (!fetch) throw new Error("Missing channel fetch");
    let inaccessible = true;
    f.guild.channels.fetch.mockImplementation(async (channelId, options) => {
        if (channelId === id && inaccessible) throw { code: 50001 };
        return fetch(channelId, options);
    });
    await expect(f.sync()).rejects.toThrow("generated stats channel");
    expect(f.created).toHaveLength(1);
    inaccessible = false;
    f.channels.delete(id);
    await f.sync();
    expect(f.created).toHaveLength(2);
    expect((await f.repository.list(f.guildId))[0]?.channel_id).toBe(
        f.created[1]?.id ?? "",
    );
});

for (const savedId of [true, false]) {
    test(`legacy locked counters explain the required repair and reuse the channel after access is restored (${savedId ? "saved ID" : "pending creation"})`, async () => {
        const f = await fixture();
        expect(f.full.has(PermissionFlagsBits.Administrator)).toBe(false);
        const row = await f.repository.prepare(f.guildId, "members");
        const old = f.makeVoice(`stats-${row.creation_token}`, categoryId, [
            {
                id: f.guildId,
                type: 0,
                allow: 0n,
                deny:
                    PermissionFlagsBits.Connect |
                    PermissionFlagsBits.SendMessages,
            },
        ]);
        if (savedId) await f.repository.attach(f.guildId, "members", old.id);
        await expect(f.guild.channels.fetch(old.id)).rejects.toThrow(
            "Missing Access",
        );
        await expect(f.sync()).rejects.toThrow(
            "A server admin must allow the bot",
        );
        expect(f.created).toHaveLength(0);
        // A server admin restores access to the existing counter.
        old.permissionOverwrites.cache.set(botId, {
            id: botId,
            type: 1,
            allow: new PermissionsBitField([
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.Connect,
                PermissionFlagsBits.ManageChannels,
            ]),
            deny: new PermissionsBitField(),
        });
        await f.sync();
        expect(old.name).toBe(counterName("members", 12));
        expect(f.created).toHaveLength(0);
        expect(
            old.permissionOverwrites.cache
                .get(f.guildId)
                ?.deny.has(PermissionFlagsBits.Connect),
        ).toBe(true);
        expect((await f.repository.list(f.guildId))[0]?.channel_id).toBe(
            old.id,
        );
        await f.sync();
        expect(f.created).toHaveLength(0);
    });
}

test("creation interrupted before saving the channel ID is recovered by its unique token", async () => {
    const f = await fixture();
    const row = await f.repository.prepare(f.guildId, "members");
    const pending = f.makeVoice(`stats-${row.creation_token}`);
    await f.sync();
    expect(f.created).toHaveLength(0);
    expect(pending.name).toBe(counterName("members", 12));
    expect((await f.repository.list(f.guildId))[0]?.channel_id).toBe(
        pending.id,
    );
    expect(
        await new StatChannelRepository(db, "100000000000000002").list(
            f.guildId,
        ),
    ).toEqual([]);
    expect(await f.repository.list("200000000000099999")).toEqual([]);
});

test("a database failure after channel creation is recovered without creating a duplicate", async () => {
    const f = await fixture();
    let failed = false;
    const flaky: Database = {
        ...db,
        async query(statement, parameters) {
            if (
                !failed &&
                statement.startsWith(
                    "update discord.server_stat_channels set channel_id",
                )
            ) {
                failed = true;
                throw new Error("Database unavailable after creation");
            }
            return db.query(statement, parameters);
        },
    };
    await expect(
        f.service.sync(
            { ...f.context, db: flaky },
            f.guild as unknown as Guild,
            true,
        ),
    ).rejects.toThrow("Database unavailable");
    expect(f.created).toHaveLength(1);
    expect((await f.repository.list(f.guildId))[0]?.channel_id).toBeNull();
    await f.freshService().sync(f.context, f.guild as unknown as Guild, true);
    expect(f.created).toHaveLength(1);
    expect(f.created[0]?.name).toBe(counterName("members", 12));
});

test("pausing while the roster is being read prevents later channel creation", async () => {
    const f = await fixture({ counters: ["humans"] });
    f.guild.members.list.mockImplementationOnce(async () => {
        await f.settings.patch(f.guildId, "server_stats", serverStatsSchema, {
            enabled: false,
        });
        return new Collection();
    });
    await expect(f.sync()).rejects.toThrow("settings changed");
    expect(f.created).toHaveLength(0);
});

test("invalid goals, missing role choices and insufficient permissions create no channels", async () => {
    for (const counters of [["goal"], ["supporters"]]) {
        const f = await fixture({ counters });
        await expect(f.sync()).rejects.toThrow();
        expect(f.created).toHaveLength(0);
    }
    const f = await fixture();
    f.category.permissionsFor.mockReturnValue(
        new PermissionsBitField(PermissionFlagsBits.ViewChannel),
    );
    await expect(f.sync()).rejects.toThrow("Manage Channels");
    expect(f.created).toHaveLength(0);
});

test("failed rename attempts keep their durable cooldown rather than repeatedly calling Discord", async () => {
    const f = await fixture();
    await f.sync();
    f.advance(statsUpdateMs);
    f.guild.memberCount = 13;
    f.created[0]?.setName.mockRejectedValueOnce(
        new Error("Discord unavailable"),
    );
    await expect(f.sync()).rejects.toThrow("Discord unavailable");
    const attempts = f.created[0]?.setName.mock.calls.length;
    await f.freshService().sync(f.context, f.guild as unknown as Guild, true);
    expect(f.created[0]?.setName.mock.calls.length).toBe(attempts);
    f.advance(statsUpdateMs);
    await f.sync();
    expect(f.created[0]?.name).toBe(counterName("members", 13));
});

test("scheduled refreshes stay throttled across service instances and roster failures change no channels", async () => {
    const f = await fixture();
    await f.sync(false);
    f.guild.memberCount = 99;
    await f.freshService().sync(f.context, f.guild as unknown as Guild);
    expect(f.created[0]?.name).toBe(counterName("members", 12));
    const failed = await fixture({ counters: ["humans"] });
    failed.guild.members.list.mockRejectedValueOnce(
        new Error("Missing member access"),
    );
    await expect(failed.sync()).rejects.toThrow("Missing member access");
    expect(failed.created).toHaveLength(0);
});

test("stats editor saves category/counters/roles/goal, previews privately and only generates when applied", async () => {
    const f = await fixture({ enabled: false, category_id: null });
    await f.open();
    await f.act("toggle");
    expect(componentText(f.payload())).toContain("Choose a category");
    await f.act("category");
    await f.act("category-select", "channel", [categoryId]);
    await f.act("counters");
    await f.act("counter-select", "string", ["members", "goal", "supporters"]);
    const shown = await f.act("goal");
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    await f.handle(
        f.event(modal.custom_id, "modal", [], {
            fields: { getTextInputValue: () => "30000" },
        }),
    );
    await f.act("supporters");
    await f.act("role-select", "role", [supporterA, supporterB]);
    f.member("700000000000000001", [supporterA, supporterB]);
    await f.act("preview");
    expect(componentText(f.payload())).toContain(counterName("goal", 30000));
    expect(componentText(f.payload())).toContain(counterName("supporters", 1));
    expect(f.created).toHaveLength(0);
    await f.act("home");
    await f.act("toggle");
    expect((await f.config()).enabled).toBe(true);
    await f.act("apply");
    expect(f.created).toHaveLength(3);
    expect((await f.config()).custom_note).toBe("Keep me");
});

test("counter separators save independently, preview privately and rename existing channels after the interval", async () => {
    const f = await fixture({
        counters: ["members", "goal", "boosts"],
        member_goal: 1000,
    });
    await f.sync();
    const ids = f.created.map((channel) => channel.id);
    await f.open();
    for (const [kind, separator, title] of [
        ["members", "|", "Members separator"],
        ["goal", "・", "Goal separator"],
    ]) {
        await f.act("separators");
        const shown = await f.act(`separator-${kind}`);
        const modal = wire(shown.showModal.mock.calls[0]?.[0]);
        expect(modal.title).toBe(title);
        expect(modal.components[0].component.value).toBe("┃");
        await f.handle(
            f.event(modal.custom_id, "modal", [], {
                fields: { getTextInputValue: () => separator },
            }),
        );
    }
    // A new editor reads the stored values, including both separate edits.
    await f.open();
    expect((await f.config()).separators).toEqual({ members: "|", goal: "・" });
    expect((await f.config()).custom_note).toBe("Keep me");
    await f.act("separators");
    const shown = await f.act("separator-members");
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    expect(modal.components[0].component.value).toBe("|");
    await f.act("home");
    await f.act("preview");
    expect(componentText(f.payload())).toContain("💚 | Members: 12");
    expect(componentText(f.payload())).toContain("🚀 ・ Goal: 1000");
    expect(componentText(f.payload())).toContain("💎 ┃ Boosts: 3");
    expect(f.created.map((channel) => channel.name)).toEqual([
        "💚 ┃ Members: 12",
        "🚀 ┃ Goal: 1000",
        "💎 ┃ Boosts: 3",
    ]);
    await f.act("home");
    await f.act("apply");
    expect(componentText(f.payload())).toContain("ten-minute update interval");
    expect(f.created[0]?.name).toBe("💚 ┃ Members: 12");
    f.advance(statsUpdateMs);
    await f.freshService().sync(f.context, f.guild as unknown as Guild, true);
    expect(f.created.map((channel) => channel.id)).toEqual(ids);
    expect(f.created.map((channel) => channel.name)).toEqual([
        "💚 | Members: 12",
        "🚀 ・ Goal: 1000",
        "💎 ┃ Boosts: 3",
    ]);
    const other = await fixture();
    expect((await other.config()).separators).toEqual({});
});

test("separator edits reject invalid values and stale modals without overwriting saved choices", async () => {
    const f = await fixture({ separators: { boosts: "・" } });
    await f.open();
    await f.act("separators");
    let shown = await f.act("separator-members");
    let modal = wire(shown.showModal.mock.calls[0]?.[0]);
    await f.handle(
        f.event(modal.custom_id, "modal", [], {
            fields: { getTextInputValue: () => "a\nb" },
        }),
    );
    expect(componentText(f.payload())).toContain("one line");
    expect((await f.config()).separators).toEqual({ boosts: "・" });
    await f.act("separators");
    shown = await f.act("separator-members");
    modal = wire(shown.showModal.mock.calls[0]?.[0]);
    await f.settings.patch(f.guildId, "server_stats", serverStatsSchema, {
        separators: { members: "•" },
    });
    await f.handle(
        f.event(modal.custom_id, "modal", [], {
            fields: { getTextInputValue: () => "|" },
        }),
    );
    expect(componentText(f.payload())).toContain("Settings changed");
    expect((await f.config()).separators).toEqual({
        members: "•",
        boosts: "・",
    });
    expect(f.created).toHaveLength(0);
});

test("stats controls reject unauthorized admins, another guild or bot, conflicts and expired sessions", async () => {
    const f = await fixture({ enabled: false });
    await f.open();
    const id = actionId(f.payload(), "toggle");
    for (const overrides of [
        { user: { id: "other" } },
        { guildId: "other" },
        { message: { author: { id: "other" } } },
        { memberPermissions: new PermissionsBitField() },
    ])
        await expect(
            f.handle(f.event(id, "button", [], overrides)),
        ).rejects.toThrow();
    await f.settings.patch(f.guildId, "server_stats", serverStatsSchema, {
        member_goal: 12,
    });
    await f.handle(f.event(id));
    expect((await f.config()).enabled).toBe(false);
    expect(componentText(f.payload())).toContain("Settings changed");
    const expired = actionId(f.payload(), "toggle");
    f.advance(15 * 60 * 1000);
    await expect(f.handle(f.event(expired))).rejects.toThrow("expired");
    expect(f.created).toHaveLength(0);
    const plugin = createServerStatsPlugin();
    await expect(
        plugin.commands?.[0]?.execute(f.context, {
            ...f.base,
            memberPermissions: new PermissionsBitField(),
            options: { getSubcommand: () => "refresh" },
        } as unknown as ChatInputCommandInteraction<"cached">),
    ).rejects.toThrow("Manage Server");
});
