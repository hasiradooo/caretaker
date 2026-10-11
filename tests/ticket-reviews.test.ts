import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { type ButtonInteraction, MessageFlags } from "discord.js";
import type { Context } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import type { Database } from "../src/database/connection";
import { ticketsPlugin } from "../src/plugins/tickets";
import { TicketRepository } from "../src/plugins/tickets/repository";
import { TicketReviewRepository } from "../src/plugins/tickets/review-repository";
import { requestTicketReview } from "../src/plugins/tickets/reviews";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001",
    openerId = "300000000000000001";
const threadId = "600000000000000001",
    messageId = "800000000000000001";
let db: Database,
    sequence = 0;
beforeAll(async () => {
    db = await testDatabase();
}, 30000);
afterAll(async () => {
    await db?.close();
});

async function fixture(closed = true) {
    const guild = {
        id: String(200000000000000000n + BigInt(++sequence)),
        name: "Kiro's **backrooms** @everyone",
    };
    const tickets = new TicketRepository(db, botId);
    await tickets.create(guild.id, threadId, openerId, "Help");
    if (closed) await tickets.close(guild.id, threadId, botId, "Resolved");
    const send = mock(async (_payload: unknown) => ({ id: messageId }));
    const fetch = mock(async (_id: string) => ({ send }));
    const context = {
        botId,
        db,
        client: { users: { fetch } },
        log: { warn: mock(() => {}), error: mock(() => {}) },
    } as unknown as Context;
    const request = () => requestTicketReview(context, guild, threadId);
    const repository = new TicketReviewRepository(db, botId);
    const token = async () => {
        const [row] = await db.query<{ token: string }>(
            "select review_token::text as token from discord.tickets where bot_id=$1 and guild_id=$2 and thread_id=$3",
            [botId, guild.id, threadId],
        );
        if (!row?.token) throw new Error("No review token");
        return row.token;
    };
    const record = async () =>
        (
            await db.query<{
                rating: number | null;
                reviewed_at: string | null;
                review_delivery_status: string;
                review_dm_message_id: string | null;
            }>(
                "select rating,reviewed_at,review_delivery_status,review_dm_message_id from discord.tickets where bot_id=$1 and guild_id=$2 and thread_id=$3",
                [botId, guild.id, threadId],
            )
        )[0];
    return { context, guild, send, fetch, request, repository, token, record };
}

function button(token: string, score = 4) {
    const interaction = {
        customId: `tickets:review:${token}:${score}`,
        guildId: null as string | null,
        user: { id: openerId },
        message: {
            id: messageId,
            author: { id: botId },
            edit: mock(async (_payload: unknown) => {}),
        },
        isRepliable: () => true,
        inCachedGuild: () => false,
        isButton: () => true,
        isChatInputCommand: () => false,
        deferred: false,
        replied: false,
        deferReply: mock(async (_payload: unknown) => {
            interaction.deferred = true;
        }),
        editReply: mock(async (_payload: unknown) => {}),
        reply: mock(async (_payload: unknown) => {}),
    };
    return interaction;
}

test("closed ticket sends one V2 DM with exactly five single-star numbered buttons", async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 6 }, f.request));
    await f.request();
    expect(f.fetch).toHaveBeenCalledWith(openerId);
    expect(f.send).toHaveBeenCalledTimes(1);
    const payload = f.send.mock.calls[0]?.[0] as {
        flags: number;
        components: { toJSON(): unknown }[];
    };
    expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
    expect(payload).not.toHaveProperty("embeds");
    expect(payload).toHaveProperty("allowedMentions.parse", []);
    expect(componentText(payload)).toContain("Ticket #0001 closed");
    expect(componentText(payload)).toContain("\\*\\*backrooms\\*\\*");
    const components = payload.components.map((c) => c.toJSON()) as {
        type: number;
        components?: {
            label: string;
            emoji: { name: string };
            custom_id: string;
        }[];
    }[];
    const buttons = components.find((c) => c.type === 1)?.components ?? [];
    expect(buttons).toHaveLength(5);
    expect(buttons.map((b) => [b.emoji.name, b.label])).toEqual(
        [1, 2, 3, 4, 5].map((n) => ["⭐", String(n)]),
    );
    expect(buttons.every((b) => b.custom_id.length <= 100)).toBe(true);
    expect(await f.record()).toMatchObject({
        review_delivery_status: "sent",
        review_dm_message_id: messageId,
        rating: null,
    });
});

test("open tickets and already-rated tickets never trigger a review DM", async () => {
    const f = await fixture(false);
    await f.request();
    expect(f.send).not.toHaveBeenCalled();
    await db.query(
        "update discord.tickets set status='closed',rating=5 where bot_id=$1 and guild_id=$2",
        [botId, f.guild.id],
    );
    await f.request();
    expect(f.send).not.toHaveBeenCalled();
});

for (const [code, status] of [
    [50007, "unavailable"],
    [50013, "failed"],
] as const) {
    test(`DM failure ${code} is recorded without repeating or failing closure`, async () => {
        const f = await fixture();
        f.send.mockImplementation(async () => {
            throw Object.assign(new Error("Cannot deliver"), { code });
        });
        await f.request();
        await f.request();
        expect(f.send).toHaveBeenCalledTimes(1);
        expect(await f.record()).toMatchObject({
            review_delivery_status: status,
            rating: null,
        });
    });
}

test("DM review goes through the runtime, persists one score and disables the buttons", async () => {
    const f = await fixture();
    await f.request();
    const interaction = button(await f.token());
    await new PluginRuntime(f.context, [ticketsPlugin]).dispatch(
        interaction as unknown as ButtonInteraction,
    );
    expect(await f.record()).toMatchObject({ rating: 4 });
    expect((await f.record())?.reviewed_at).not.toBeNull();
    expect(componentText(interaction.editReply.mock.calls[0]?.[0])).toContain(
        "4/5",
    );
    const edited = interaction.message.edit.mock.calls[0]?.[0] as {
        components: { toJSON(): unknown }[];
    };
    const row = edited.components
        .map((c) => c.toJSON())
        .find((c) => (c as { type: number }).type === 1) as {
        components: { disabled: boolean; label: string; style: number }[];
    };
    expect(row.components.every((c) => c.disabled)).toBe(true);
    expect(row.components.find((c) => c.label === "4")?.style).toBe(3);
    expect(f.context.log.error).not.toHaveBeenCalled();
});

test("simultaneous clicks and fresh repository instances cannot change the first score", async () => {
    const f = await fixture();
    await f.request();
    const token = await f.token();
    const results = await Promise.all(
        [2, 5, 1, 4].map((score) =>
            new TicketReviewRepository(db, botId).rate(token, openerId, score),
        ),
    );
    expect(new Set(results.map((r) => r?.rating)).size).toBe(1);
    const prior = (await f.record())?.rating;
    await f.repository.rate(token, openerId, 3);
    expect((await f.record())?.rating).toBe(prior);
});

for (const tamper of [
    "user",
    "author",
    "message",
    "score",
    "token",
    "guild",
] as const) {
    test(`review rejects a forged ${tamper} without saving a rating`, async () => {
        const f = await fixture();
        await f.request();
        const interaction = button(await f.token());
        if (tamper === "user") interaction.user.id = "300000000000000099";
        if (tamper === "author")
            interaction.message.author.id = "100000000000000099";
        if (tamper === "message") interaction.message.id = "800000000000000099";
        if (tamper === "score")
            interaction.customId = interaction.customId.replace(/:4$/, ":6");
        if (tamper === "token")
            interaction.customId = `tickets:review:${crypto.randomUUID()}:4`;
        if (tamper === "guild") interaction.guildId = f.guild.id;
        await new PluginRuntime(f.context, [ticketsPlugin]).dispatch(
            interaction as unknown as ButtonInteraction,
        );
        expect((await f.record())?.rating).toBeNull();
        expect(interaction.message.edit).not.toHaveBeenCalled();
    });
}

test("review tokens cannot cross bot boundaries or rate another opener's ticket", async () => {
    const f = await fixture();
    await f.request();
    const token = await f.token();
    expect(
        await new TicketReviewRepository(db, "100000000000000099").rate(
            token,
            openerId,
            5,
        ),
    ).toBeUndefined();
    expect(
        await f.repository.rate(token, "300000000000000099", 5),
    ).toBeUndefined();
    await expect(f.repository.rate(token, openerId, 0)).rejects.toThrow(
        "between 1 and 5",
    );
    expect((await f.record())?.rating).toBeNull();
});

test("a sent review still works if saving the DM message ID was interrupted", async () => {
    const f = await fixture();
    f.context.db = {
        ...db,
        query: async (sql, params) => {
            if (
                sql.startsWith(
                    "update discord.tickets set review_delivery_status=",
                )
            )
                throw new Error("Lost database connection");
            return db.query(sql, params);
        },
    } as Database;
    await f.request();
    f.context.db = db;
    await f.request();
    expect(f.send).toHaveBeenCalledTimes(1);
    const interaction = button(await f.token(), 5);
    await new PluginRuntime(f.context, [ticketsPlugin]).dispatch(
        interaction as unknown as ButtonInteraction,
    );
    expect((await f.record())?.rating).toBe(5);
});

test("unrelated DM buttons retain the existing server-only restriction", async () => {
    const f = await fixture();
    const interaction = button(crypto.randomUUID());
    interaction.customId = "tickets:open";
    await new PluginRuntime(f.context, [ticketsPlugin]).dispatch(
        interaction as unknown as ButtonInteraction,
    );
    expect(componentText(interaction.reply.mock.calls[0]?.[0])).toContain(
        "Meet me in the server",
    );
    expect(f.send).not.toHaveBeenCalled();
});
