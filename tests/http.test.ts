import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, Collection, type Guild } from "discord.js";
import { readEnvironment } from "../src/config/environment";
import type { Context } from "../src/core/plugin";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { StateStore } from "../src/database/state-store";
import { createHttpHandler, validApiKey } from "../src/http/server";
import { createPlugins } from "../src/plugins";
import { createLogger } from "../src/shared/logger";
import { testDatabase } from "./helpers/database";

const secret = "test-secret-".repeat(4),
    botId = "100000000000000011",
    guildId = "200000000000000011";
let db: Database;
let handler: ReturnType<typeof createHttpHandler>;
beforeAll(async () => {
    db = await testDatabase();
    const client = new Client({ intents: [] });
    const guild = { id: guildId, name: "Test server", memberCount: 3 } as Guild;
    Object.defineProperty(client.guilds, "cache", {
        value: new Collection([[guildId, guild]]),
    });
    const env = readEnvironment({
        DISCORD_TOKEN: "test-only",
        DISCORD_CLIENT_ID: botId,
        DATABASE_URL: "postgres://localhost/test",
        MASTER_ENCRYPTION_KEY: "ab".repeat(32),
        API_SECRET_KEY: secret,
    });
    const context: Context = {
        client,
        botId,
        env,
        db,
        settings: new SettingsStore(db, botId),
        state: new StateStore(db, botId),
        log: createLogger("test", "error"),
    };
    handler = createHttpHandler(context, createPlugins());
}, 30000);
afterAll(async () => {
    await db?.close();
});

function request(
    path: string,
    method = "GET",
    body?: string,
    authenticated = true,
) {
    return new Request(`http://localhost${path}`, {
        method,
        headers: {
            ...(authenticated ? { Authorization: `Bearer ${secret}` } : {}),
            "Content-Type": "application/json",
        },
        ...(body ? { body } : {}),
    });
}
const guildPath = `/discord/v1/bots/${botId}/guilds/${guildId}`;

test("API authentication fails closed", async () => {
    expect(validApiKey("anything", undefined)).toBe(false);
    expect(validApiKey("wrong", secret)).toBe(false);
    expect(validApiKey(secret, secret)).toBe(true);
    expect(
        (
            await handler(
                request(`${guildPath}/plugins`, "GET", undefined, false),
            )
        ).status,
    ).toBe(401);
});
test("API rejects another bot or a guild the bot has not joined", async () => {
    expect(
        (await handler(request(guildPath.replace(botId, "100000000000000012"))))
            .status,
    ).toBe(404);
    expect(
        (
            await handler(
                request(guildPath.replace(guildId, "200000000000000012")),
            )
        ).status,
    ).toBe(404);
});
test("API validates patches and preserves existing nested settings", async () => {
    const path = `${guildPath}/plugins/levels`;
    expect(
        (
            await handler(
                request(
                    path,
                    "PATCH",
                    JSON.stringify({
                        enabled: true,
                        config: { xp_gain: { min: 5, max: 50 } },
                    }),
                ),
            )
        ).status,
    ).toBe(200);
    expect(
        (
            await handler(
                request(
                    path,
                    "PATCH",
                    JSON.stringify({ config: { xp_gain: { min: 100 } } }),
                ),
            )
        ).status,
    ).toBe(400);
    const response = await handler(request(path));
    expect((await response.json()).data.xp_gain).toEqual({ min: 5, max: 50 });
    expect((await handler(request(path, "PATCH", "{broken"))).status).toBe(400);
    expect(
        (
            await handler(
                request(path, "PATCH", JSON.stringify({ enabled: "false" })),
            )
        ).status,
    ).toBe(400);
});
test("API rejects invalid pagination and calendar dates", async () => {
    expect(
        (await handler(request(`${guildPath}/leaderboard?page=0`))).status,
    ).toBe(400);
    expect(
        (await handler(request(`${guildPath}/leaderboard?limit=NaN`))).status,
    ).toBe(400);
    expect(
        (
            await handler(
                request(
                    `${guildPath}/birthdays/300000000000000011`,
                    "PUT",
                    '{"day":31,"month":4}',
                ),
            )
        ).status,
    ).toBe(400);
});
test("API rejects oversized bodies and unsupported webhooks explicitly", async () => {
    expect(
        (
            await handler(
                request(
                    `${guildPath}/plugins/levels`,
                    "PATCH",
                    JSON.stringify({ content: "x".repeat(66000) }),
                ),
            )
        ).status,
    ).toBe(400);
    expect(
        (await handler(request("/discord/v1/webhooks/patreon", "POST", "{}")))
            .status,
    ).toBe(501);
});
