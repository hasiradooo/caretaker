import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
    type AnyThreadChannel,
    ChannelType,
    type ClientEvents,
    Collection,
    ComponentType,
    Events,
    type Message,
    type MessageReaction,
    type PartialMessageReaction,
    PermissionFlagsBits,
    PermissionsBitField,
} from "discord.js";
import type { Context, EventRegistrar } from "../src/core/plugin";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { createStarboardPlugin } from "../src/plugins/starboard";
import {
    type StarboardSettings,
    starboardSchema,
} from "../src/plugins/starboard/config";
import { componentText } from "../src/shared/messages";

let db: Database;
let sequence = 0;
const botId = "100000000000000001";
const guildId = "200000000000000001";
const authorId = "300000000000000001";
const channelId = "400000000000000001";
const targetId = "400000000000000002";
beforeAll(async () => {
    db = await (await import("./helpers/database")).testDatabase();
}, 30000);
afterAll(async () => {
    await db?.close();
});

async function fixture(config: Partial<StarboardSettings> = {}) {
    const id = String(500000000000000000n + BigInt(++sequence));
    const settings = new SettingsStore(db, botId);
    await settings.patch(guildId, "starboard", starboardSchema, {
        enabled: true,
        auto_react: true,
        channel_id: targetId,
        watch_channels: [channelId],
        emoji: "⭐",
        threshold: 2,
        allow_self_star: false,
        ...config,
    });
    const full = new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.SendMessages,
    ]);
    const send = mock(async (_payload: unknown) => ({
        id: `highlight-${id}`,
        delete: mock(async () => {}),
    }));
    const target = {
        id: targetId,
        nsfw: false,
        isSendable: () => true,
        isThread: () => false,
        permissionsFor: () => full,
        send,
        messages: {
            edit: mock(async (_id: string, _payload: unknown) => {}),
            delete: mock(async () => {}),
        },
    };
    const guild = {
        id: guildId,
        roles: { everyone: { id: guildId } },
        members: { me: { id: botId } },
        channels: { fetch: mock(async () => target) },
    };
    const source = {
        id: channelId,
        guild,
        type: ChannelType.GuildText as ChannelType,
        parentId: channelId,
        parent: { nsfw: false, type: ChannelType.GuildForum as ChannelType },
        nsfw: false,
        archived: false,
        locked: false,
        isThread: mock(() => false),
        permissionsFor: mock((_member: unknown) => full),
    };
    const cache = new Collection<string, MessageReaction>();
    const authorReactions = new Collection<string, { id: string }>();
    const message = {
        id,
        guildId,
        guild,
        channelId,
        channel: source,
        inGuild: () => true,
        system: false,
        webhookId: null as string | null,
        partial: false,
        author: {
            id: authorId,
            bot: false,
            displayAvatarURL: () =>
                "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        content: "A community post",
        createdTimestamp: Date.now(),
        attachments: new Collection<
            string,
            {
                url: string;
                contentType: string | null;
                name: string;
                spoiler: boolean;
            }
        >(),
        url: `https://discord.com/channels/${guildId}/${channelId}/${id}`,
        reactions: { cache },
        react: mock(async (emoji: string) => {
            const reaction = makeReaction(1, true, emoji);
            cache.set(emoji, reaction);
            return reaction;
        }),
    };
    const fetch = mock(async () => message as unknown as Message<true>);
    Object.assign(message, { fetch });
    function makeReaction(count: number, me: boolean, emoji = "⭐") {
        const custom = /^<a?:([^:]+):(\d+)>$/.exec(emoji);
        return {
            count,
            me,
            partial: false,
            message,
            emoji: {
                id: custom?.[2] ?? null,
                name: custom?.[1] ?? emoji,
                toString: () => emoji,
            },
            users: { fetch: mock(async () => authorReactions) },
        } as unknown as MessageReaction;
    }
    const handlers: Partial<{
        [K in keyof ClientEvents]: (...args: ClientEvents[K]) => Promise<void>;
    }> = {};
    const registrar: EventRegistrar = {
        on(event, handler) {
            Object.assign(handlers, { [event]: handler });
        },
        every() {},
    };
    const log = { debug: mock(() => {}), warn: mock(() => {}) };
    const plugin = createStarboardPlugin();
    plugin.register?.(
        { botId, db, settings, log } as unknown as Context,
        registrar,
    );
    return {
        settings,
        source,
        target,
        message,
        fetch,
        log,
        cache,
        makeReaction,
        authorReactions,
        create: () =>
            handlers[Events.MessageCreate]?.(
                message as unknown as Message<true>,
            ),
        thread: (newlyCreated = true) =>
            handlers[Events.ThreadCreate]?.(
                {
                    ...source,
                    guildId,
                    fetchStarterMessage: fetch,
                } as unknown as AnyThreadChannel,
                newlyCreated,
            ),
        add: (reaction: MessageReaction | PartialMessageReaction) =>
            handlers[Events.MessageReactionAdd]?.(
                reaction,
                {
                    id: authorId,
                } as ClientEvents[typeof Events.MessageReactionAdd][1],
                {} as ClientEvents[typeof Events.MessageReactionAdd][2],
            ),
        removeOwn: (reaction: MessageReaction) =>
            handlers[Events.MessageReactionRemove]?.(
                reaction,
                {
                    id: botId,
                } as ClientEvents[typeof Events.MessageReactionRemove][1],
                {} as ClientEvents[typeof Events.MessageReactionRemove][2],
            ),
        rows: () =>
            db.query<{ star_count: number }>(
                "select star_count from discord.starboards where bot_id=$1 and guild_id=$2 and source_message_id=$3",
                [botId, guildId, id],
            ),
    };
}

for (const emoji of [
    "⭐",
    "<:highlight:800000000000000001>",
    "<a:highlight:800000000000000001>",
]) {
    test(`auto-reactions seed the configured ${emoji} once for overlapping creates`, async () => {
        const f = await fixture({ emoji });
        await Promise.all([f.create(), f.create()]);
        expect(f.message.react).toHaveBeenCalledTimes(1);
        expect(f.message.react).toHaveBeenCalledWith(emoji);
        expect(f.target.send).not.toHaveBeenCalled();
        expect(await f.rows()).toHaveLength(0);
    });
}

for (const [name, config] of [
    ["off", { auto_react: false }],
    ["paused", { enabled: false }],
    ["no destination", { channel_id: null }],
    ["watch none", { watch_channels: [] }],
    ["unwatched", { watch_channels: ["400000000000000099"] }],
] satisfies Array<[string, Partial<StarboardSettings>]>) {
    test(`auto-reactions skip ${name}`, async () => {
        const f = await fixture(config);
        await f.create();
        expect(f.message.react).not.toHaveBeenCalled();
    });
}

for (const scenario of [
    "bot",
    "system",
    "webhook",
    "dm",
    "inaccessible",
    "private-thread",
    "destination",
    "destination-thread",
    "adult",
    "archived",
    "locked",
] as const) {
    test(`auto-reactions exclude ${scenario} messages`, async () => {
        const f = await fixture({ watch_channels: null });
        if (scenario === "bot") f.message.author.bot = true;
        if (scenario === "system") f.message.system = true;
        if (scenario === "webhook") f.message.webhookId = "600000000000000001";
        if (scenario === "dm") f.message.inGuild = () => false;
        if (scenario === "inaccessible")
            f.source.permissionsFor.mockImplementation(
                () => new PermissionsBitField(),
            );
        if (scenario === "destination") f.message.channelId = targetId;
        if (scenario === "adult") f.source.nsfw = true;
        if (
            [
                "private-thread",
                "destination-thread",
                "archived",
                "locked",
            ].includes(scenario)
        ) {
            f.source.isThread.mockImplementation(() => true);
            if (scenario === "private-thread")
                f.source.type = ChannelType.PrivateThread;
            if (scenario === "destination-thread") f.source.parentId = targetId;
            if (scenario === "archived") f.source.archived = true;
            if (scenario === "locked") f.source.locked = true;
        }
        await f.create();
        expect(f.message.react).not.toHaveBeenCalled();
    });
}

test("all accessible channels, public threads and new forum/media posts receive starter reactions", async () => {
    const all = await fixture({ watch_channels: null });
    await all.create();
    expect(all.message.react).toHaveBeenCalledTimes(1);
    for (const parentType of [
        ChannelType.GuildText,
        ChannelType.GuildForum,
        ChannelType.GuildMedia,
    ]) {
        const f = await fixture();
        f.source.isThread.mockImplementation(() => true);
        f.source.type = ChannelType.PublicThread;
        f.source.parent.type = parentType;
        f.message.channelId = f.source.id = "400000000000000003";
        if (parentType === ChannelType.GuildText) await f.create();
        else await f.thread();
        expect(f.message.react).toHaveBeenCalledTimes(1);
    }
});

for (const watchChannels of [null, [channelId]]) {
    for (const kind of ["text", "announcement", "thread", "forum", "media"]) {
        test(`${kind === "thread" ? "public thread in a private channel" : `private ${kind} source`} supports reactions and highlights when ${watchChannels ? "selected" : "watching all"}`, async () => {
            const f = await fixture({ watch_channels: watchChannels });
            const full = f.source.permissionsFor({});
            f.source.permissionsFor.mockImplementation((member) =>
                member === f.message.guild.roles.everyone
                    ? new PermissionsBitField()
                    : full,
            );
            if (kind === "announcement")
                f.source.type = ChannelType.GuildAnnouncement;
            if (["thread", "forum", "media"].includes(kind)) {
                f.source.isThread.mockReturnValue(true);
                f.source.type = ChannelType.PublicThread;
                f.message.channelId = f.source.id = "400000000000000003";
                f.source.parent.type =
                    kind === "forum"
                        ? ChannelType.GuildForum
                        : kind === "media"
                          ? ChannelType.GuildMedia
                          : ChannelType.GuildText;
            }
            if (kind === "forum" || kind === "media") await f.thread();
            else await f.create();
            expect(f.message.react).toHaveBeenCalledTimes(1);
            await f.add(f.makeReaction(3, true));
            expect(f.target.send).toHaveBeenCalledTimes(1);
            expect(await f.rows()).toEqual([{ star_count: 2 }]);
        });
    }
}

for (const permission of [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
]) {
    test(`revoking source permission ${permission} stops highlights and auto-reactions`, async () => {
        const f = await fixture();
        const full = f.source.permissionsFor({});
        let revoked = false;
        f.source.permissionsFor.mockImplementation((member) =>
            member === f.message.guild.roles.everyone
                ? new PermissionsBitField()
                : revoked
                  ? new PermissionsBitField(full.bitfield & ~permission)
                  : full,
        );
        await f.add(f.makeReaction(2, false));
        expect(f.target.send).toHaveBeenCalledTimes(1);
        revoked = true;
        await f.create();
        await f.add(f.makeReaction(3, false));
        expect(f.message.react).not.toHaveBeenCalled();
        expect(f.target.messages.edit).not.toHaveBeenCalled();
        expect(f.target.send).toHaveBeenCalledTimes(1);
        expect(await f.rows()).toEqual([{ star_count: 2 }]);
    });
}

test("discovering an existing forum post does not backfill its reaction", async () => {
    const f = await fixture();
    f.source.isThread.mockImplementation(() => true);
    f.source.type = ChannelType.PublicThread;
    await f.thread(false);
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.message.react).not.toHaveBeenCalled();
});

for (const permission of [
    PermissionFlagsBits.AddReactions,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.ViewChannel,
]) {
    test(`missing permission ${permission} skips auto-reactions without failing`, async () => {
        const f = await fixture();
        const full = f.source.permissionsFor({});
        f.source.permissionsFor.mockImplementation((member) =>
            member === f.message.guild.roles.everyone
                ? full
                : new PermissionsBitField(full.bitfield & ~permission),
        );
        await f.create();
        expect(f.message.react).not.toHaveBeenCalled();
        expect(f.log.warn).not.toHaveBeenCalled();
    });
}

test("deleted posts are ignored and other reaction failures are logged without stopping the next post", async () => {
    const f = await fixture();
    f.message.react.mockRejectedValueOnce(
        Object.assign(new Error("Unknown Message"), { code: 10008 }),
    );
    await f.create();
    expect(f.log.warn).not.toHaveBeenCalled();
    f.message.react.mockRejectedValueOnce(new Error("Missing permissions"));
    await f.create();
    expect(f.log.warn).toHaveBeenCalledTimes(1);
    await f.create();
    expect(f.message.react).toHaveBeenCalledTimes(3);
});

test("starter reactions do not satisfy the threshold, inflate highlights or prevent removal", async () => {
    const f = await fixture();
    await f.add(f.makeReaction(1, true));
    await f.add(f.makeReaction(2, true));
    expect(f.target.send).not.toHaveBeenCalled();
    await f.add(f.makeReaction(3, true));
    expect(componentText(f.target.send.mock.calls[0]?.[0])).toContain(
        "⭐ **2**",
    );
    expect(await f.rows()).toEqual([{ star_count: 2 }]);
    // Turning seeding off must not suddenly give old posts an extra vote.
    await f.settings.patch(guildId, "starboard", starboardSchema, {
        auto_react: false,
    });
    await f.add(f.makeReaction(2, true));
    expect(f.target.messages.delete).toHaveBeenCalledTimes(1);
    expect(await f.rows()).toHaveLength(0);
});

test("self-stars remain independently excluded alongside the starter reaction", async () => {
    const f = await fixture();
    f.authorReactions.set(authorId, { id: authorId });
    await f.add(f.makeReaction(3, true));
    expect(f.target.send).not.toHaveBeenCalled();
    await f.settings.patch(guildId, "starboard", starboardSchema, {
        allow_self_star: true,
    });
    await f.add(f.makeReaction(3, true));
    expect(await f.rows()).toEqual([{ star_count: 2 }]);
});

test("after a restart, an uncached reaction uses the fetched own-reaction flag", async () => {
    const f = await fixture();
    const snapshot = f.makeReaction(2, true);
    f.cache.set("⭐", snapshot);
    const partial = {
        ...f.makeReaction(0, false),
        count: null,
        partial: true,
    } as unknown as PartialMessageReaction;
    await f.add(partial);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.target.send).not.toHaveBeenCalled();
});

test("removing the bot's starter refreshes Discord's cached count", async () => {
    const f = await fixture();
    f.cache.set("⭐", f.makeReaction(1, false));
    await f.removeOwn(f.makeReaction(2, false));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.target.send).not.toHaveBeenCalled();
});

test("photo attachments preview as a gallery on new and updated highlights without revealing spoilers", async () => {
    const f = await fixture();
    f.message.content = "";
    const attachments = [
        { name: "one.png", contentType: "image/png", spoiler: false },
        { name: "two.JPG", contentType: null, spoiler: false },
        { name: "SPOILER_hidden.png", contentType: "image/png", spoiler: true },
        { name: "notes.pdf", contentType: "application/pdf", spoiler: false },
        { name: "clip.mp4", contentType: "video/mp4", spoiler: false },
        { name: "fake.png", contentType: "application/pdf", spoiler: false },
    ];
    for (const attachment of attachments)
        f.message.attachments.set(attachment.name, {
            ...attachment,
            url: `https://cdn.discordapp.com/attachments/example/${attachment.name}`,
        });
    const gallery = (payload: unknown) =>
        JSON.parse(JSON.stringify(payload)).components.find(
            (item: { type: number }) =>
                item.type === ComponentType.MediaGallery,
        );
    await f.add(f.makeReaction(2, false));
    const posted = f.target.send.mock.calls[0]?.[0];
    expect(
        gallery(posted)?.items.map(
            (item: { media: { url: string } }) => item.media.url,
        ),
    ).toEqual([
        "https://cdn.discordapp.com/attachments/example/one.png",
        "https://cdn.discordapp.com/attachments/example/two.JPG",
    ]);
    expect(componentText(posted)).toContain("Photo attachments");
    f.message.attachments.delete("one.png");
    await f.add(f.makeReaction(3, false));
    const updated = f.target.messages.edit.mock.calls[0]?.[1];
    expect(gallery(updated)?.items).toHaveLength(1);
    expect(gallery(updated)?.items[0].media.url).toBe(
        "https://cdn.discordapp.com/attachments/example/two.JPG",
    );
    expect(f.target.send).toHaveBeenCalledTimes(1);
});
