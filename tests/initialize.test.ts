import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { initializeDatabase } from "../src/database/initialize";
import { assertMigrationsCurrent, migrate } from "../src/database/migrations";
import { emptyDatabase } from "./helpers/database";

const baseline = `${import.meta.dir}/../database/baseline.sql`;
const migrations = `${import.meta.dir}/../migrations`;

test("portable initialization creates the complete schema and refuses to replace it", async () => {
    const db = await emptyDatabase();
    try {
        expect(await initializeDatabase(db, baseline, migrations)).toContain(
            "001_caretaker_runtime.sql",
        );
        const tables = await db.query<{ tablename: string }>(
            "select tablename from pg_tables where schemaname='discord'",
        );
        expect(tables.map((row) => row.tablename)).toContain("linked_accounts");
        expect(tables.map((row) => row.tablename)).toContain("runtime_leases");
        await db.query(
            "insert into discord.user_levels(bot_id,guild_id,user_id,xp) values ('bot','guild','user',123)",
        );
        await expect(
            initializeDatabase(db, baseline, migrations),
        ).rejects.toThrow("already exists");
        expect(
            (
                await db.query<{ xp: number }>(
                    "select xp from discord.user_levels",
                )
            )[0]?.xp,
        ).toBe(123);
    } finally {
        await db.close();
    }
}, 30000);

test("upgrade retains legacy rows, plugin fields and unrelated feature data", async () => {
    const db = await emptyDatabase();
    try {
        await db.query(await readFile(baseline, "utf8"));
        await db.query(
            "insert into discord.user_levels(bot_id,guild_id,user_id,xp,level) values ('bot','guild','user',42,3)",
        );
        await db.query(
            "insert into discord.plugins(bot_id,guild_id,plugin_name,enabled,config) values ('bot','guild','custom',true,'{\"legacy\":123}')",
        );
        await db.query(
            "insert into discord.user_balances(bot_id,guild_id,user_id,amount) values ('bot','guild','user',999)",
        );
        await migrate(db, migrations);
        expect(
            (
                await db.query<{ xp: number; level: number }>(
                    "select xp,level from discord.user_levels",
                )
            )[0],
        ).toEqual({ xp: 42, level: 3 });
        expect(
            (
                await db.query<{ config: object }>(
                    "select config from discord.plugins",
                )
            )[0]?.config,
        ).toEqual({ legacy: 123 });
        expect(
            String(
                (
                    await db.query<{ amount: string }>(
                        "select amount from discord.user_balances",
                    )
                )[0]?.amount,
            ),
        ).toBe("999");
        expect(await migrate(db, migrations)).toEqual([]);
        await assertMigrationsCurrent(db, migrations);
        await db.query(
            "update discord.caretaker_migrations set checksum='modified' where name='001_caretaker_runtime.sql'",
        );
        await expect(assertMigrationsCurrent(db, migrations)).rejects.toThrow(
            "Applied migration changed",
        );
    } finally {
        await db.close();
    }
}, 30000);
