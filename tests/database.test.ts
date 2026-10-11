import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "../src/database/connection";
import { RuntimeLease } from "../src/database/lease";
import { migrate } from "../src/database/migrations";
import { SettingsStore } from "../src/database/settings-store";
import { StateStore } from "../src/database/state-store";
import { BirthdayRepository } from "../src/plugins/birthday/repository";
import { levelsSchema } from "../src/plugins/levels/config";
import { LevelsRepository } from "../src/plugins/levels/repository";
import { TicketRepository } from "../src/plugins/tickets/repository";
import { testDatabase } from "./helpers/database";

let db: Database;
const bot = "100000000000000001",
    guild = "200000000000000001",
    user = "300000000000000001";
beforeAll(async () => {
    db = await testDatabase();
}, 30000);
afterAll(async () => {
    await db?.close();
});

describe("legacy database compatibility", () => {
    test("migrations are repeatable and retain existing rows", async () => {
        await db.query(
            "insert into discord.user_levels (bot_id,guild_id,user_id,level,xp) values ($1,$2,$3,2,500)",
            [bot, guild, user],
        );
        expect(await migrate(db, `${import.meta.dir}/../migrations`)).toEqual(
            [],
        );
        const row = await new LevelsRepository(db, bot).get(guild, user);
        expect(row?.level).toBe(2);
        expect(row?.xp).toBe(500);
    });
    test("partial settings merge preserves siblings and unknown legacy fields", async () => {
        const store = new SettingsStore(db, bot);
        await store.patch(guild, "levels", levelsSchema, {
            enabled: true,
            xp_gain: { min: 20, max: 40 },
            legacy_note: "keep",
        });
        await store.patch(guild, "levels", levelsSchema, {
            xp_gain: { min: 25 },
        });
        const settings = await store.get(guild, "levels", levelsSchema);
        expect(settings.xp_gain).toEqual({ min: 25, max: 40 });
        expect(settings.legacy_note).toBe("keep");
        await expect(
            store.patch(guild, "levels", levelsSchema, {
                xp_gain: { min: 100 },
            }),
        ).rejects.toThrow();
        expect(
            (await store.get(guild, "levels", levelsSchema)).xp_gain.min,
        ).toBe(25);
    });
    test("settings remain isolated between guilds and bot applications", async () => {
        expect(
            (
                await new SettingsStore(db, "100000000000000002").get(
                    guild,
                    "levels",
                    levelsSchema,
                )
            ).enabled,
        ).toBe(false);
        expect(
            (
                await new SettingsStore(db, bot).get(
                    "200000000000000002",
                    "levels",
                    levelsSchema,
                )
            ).enabled,
        ).toBe(false);
    });
    test("stale settings editors cannot overwrite more recent edits", async () => {
        const store = new SettingsStore(db, bot);
        const initial = await store.raw(guild, "levels");
        await store.patch(guild, "levels", levelsSchema, {
            reward_message: "A newer edit",
        });
        await expect(
            store.patch(
                guild,
                "levels",
                levelsSchema,
                { reward_message: "Stale edit" },
                initial.revision,
            ),
        ).rejects.toThrow("Settings changed");
        expect(
            (await store.get(guild, "levels", levelsSchema)).reward_message,
        ).toBe("A newer edit");
    });
    test("persisted enabled column wins over legacy JSON", async () => {
        await db.query(
            "insert into discord.plugins (bot_id,guild_id,plugin_name,enabled,config) values ($1,$2,'levels',false,'{\"enabled\":true}')",
            [bot, "200000000000000003"],
        );
        expect(
            (
                await new SettingsStore(db, bot).get(
                    "200000000000000003",
                    "levels",
                    levelsSchema,
                )
            ).enabled,
        ).toBe(false);
    });
    test("XP awards use configured gain, preserve residual format and enforce cooldown", async () => {
        const levels = new LevelsRepository(db, bot);
        await levels.set(guild, "300000000000000002", 2990);
        const now = new Date("2026-10-10T10:00:00Z");
        const award = await levels.award(
            guild,
            "300000000000000002",
            20,
            60,
            now,
        );
        expect(award?.row.level).toBe(1);
        expect(award?.row.xp).toBe(10);
        expect(
            await levels.award(
                guild,
                "300000000000000002",
                20,
                60,
                new Date(now.getTime() + 59000),
            ),
        ).toBeNull();
        expect(
            (
                await levels.award(
                    guild,
                    "300000000000000002",
                    20,
                    60,
                    new Date(now.getTime() + 60000),
                )
            )?.row.xp,
        ).toBe(30);
    });
    test("simultaneous XP awards do not lose updates or bypass cooldown", async () => {
        const levels = new LevelsRepository(db, bot);
        const awards = await Promise.all(
            Array.from({ length: 8 }, () =>
                levels.award(
                    guild,
                    "300000000000000003",
                    25,
                    60,
                    new Date("2026-10-10T10:00:00Z"),
                ),
            ),
        );
        expect(awards.filter(Boolean)).toHaveLength(1);
        expect((await levels.get(guild, "300000000000000003"))?.xp).toBe(25);
    });
    test("leaderboards sort level before residual XP and never mix bots", async () => {
        const own = new LevelsRepository(db, bot);
        await own.set("200000000000000004", "300000000000000004", 3001);
        await own.set("200000000000000004", "300000000000000005", 2999);
        await new LevelsRepository(db, "100000000000000002").set(
            "200000000000000004",
            user,
            100000,
        );
        const rows = await own.leaderboard("200000000000000004");
        expect(rows.map((row) => row.user_id)).toEqual([
            "300000000000000004",
            "300000000000000005",
        ]);
        expect(rows.map((row) => row.rank)).toEqual([1, 2]);
    });
    test("ambiguous old XP rows are not silently rewritten", async () => {
        await db.query(
            "insert into discord.user_levels (bot_id,guild_id,user_id,level,xp) values ($1,$2,$3,1,9000)",
            [bot, guild, "300000000000000006"],
        );
        await expect(
            new LevelsRepository(db, bot).award(
                guild,
                "300000000000000006",
                20,
                60,
            ),
        ).rejects.toThrow("explicit repair");
    });
    test("birthdays use original day/month/year columns and validate calendar dates", async () => {
        const birthdays = new BirthdayRepository(db, bot);
        await birthdays.set(guild, user, { day: 29, month: 2 });
        expect((await birthdays.onDate(guild, 2, 29))[0]?.user_id).toBe(user);
        await expect(
            birthdays.set(guild, user, { day: 31, month: 4 }),
        ).rejects.toThrow();
        await birthdays.remove(guild, user);
        expect(await birthdays.get(guild, user)).toBeUndefined();
    });
    test("ticket claims have one winner and cannot cross bot boundaries", async () => {
        const tickets = new TicketRepository(db, bot);
        await tickets.create(guild, "400000000000000001", user, "Test");
        expect(
            await tickets.claim(
                guild,
                "400000000000000001",
                "300000000000000008",
            ),
        ).toBe(true);
        expect(
            await tickets.claim(
                guild,
                "400000000000000001",
                "300000000000000009",
            ),
        ).toBe(false);
        expect(
            await new TicketRepository(db, "100000000000000002").get(
                guild,
                "400000000000000001",
            ),
        ).toBeUndefined();
        await tickets.close(guild, "400000000000000001", user, "Done");
        expect(await tickets.open(guild, user)).toEqual([]);
    });
    test("scheduled-event claims survive fresh store instances", async () => {
        expect(
            await new StateStore(db, bot).claim(
                guild,
                "birthday",
                "2026-10-10:user",
                60,
            ),
        ).toBe(true);
        expect(
            await new StateStore(db, bot).claim(
                guild,
                "birthday",
                "2026-10-10:user",
                60,
            ),
        ).toBe(false);
        expect(
            await new StateStore(db, "100000000000000002").claim(
                guild,
                "birthday",
                "2026-10-10:user",
                60,
            ),
        ).toBe(true);
    });
    test("a second bot process cannot take over a live lease", async () => {
        const first = new RuntimeLease(db, bot),
            second = new RuntimeLease(db, bot);
        expect(await first.acquire()).toBe(true);
        expect(await second.acquire()).toBe(false);
        expect(await second.renew()).toBe(false);
        expect(await first.renew()).toBe(true);
        await second.release();
        expect(await first.renew()).toBe(true);
        await first.release();
        expect(await second.acquire()).toBe(true);
        await second.release();
    });
});
