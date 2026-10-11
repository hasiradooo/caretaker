import { expect, mock, test } from "bun:test";
import type { Database } from "../src/database/connection";
import {
    SettingsStore,
    type StoredSettings,
} from "../src/database/settings-store";
import { levelsSchema } from "../src/plugins/levels/config";
import { testDatabase } from "./helpers/database";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

test("concurrent settings reads share one database request", async () => {
    const pending = deferred<StoredSettings[]>();
    const query = mock(() => pending.promise);
    const store = new SettingsStore({ query } as unknown as Database, "bot");
    const reads = Array.from({ length: 10 }, () =>
        store.get("guild", "levels", levelsSchema),
    );
    expect(query).toHaveBeenCalledTimes(1);
    pending.resolve([{ enabled: true, config: {}, revision: null }]);
    expect((await Promise.all(reads)).every((config) => config.enabled)).toBe(
        true,
    );
});

test("a failed read is retried instead of poisoning the cache", async () => {
    let calls = 0;
    const query = mock(async () => {
        if (++calls === 1) throw new Error("temporary database outage");
        return [];
    });
    const store = new SettingsStore({ query } as unknown as Database, "bot");
    await expect(store.get("guild", "levels", levelsSchema)).rejects.toThrow(
        "outage",
    );
    expect((await store.get("guild", "levels", levelsSchema)).enabled).toBe(
        false,
    );
    expect(query).toHaveBeenCalledTimes(2);
});

test("a read started before a settings edit cannot recache the old values after the edit", async () => {
    const db = await testDatabase();
    try {
        const captured = deferred<void>(),
            release = deferred<void>();
        const proxy: Database = {
            ...db,
            async query<T extends object>(statement: string, parameters = []) {
                const rows = await db.query<T>(statement, parameters);
                captured.resolve();
                await release.promise;
                return rows;
            },
        };
        const store = new SettingsStore(proxy, "100000000000000001");
        const guildId = "200000000000000001";
        const oldRead = store.get(guildId, "levels", levelsSchema);
        await captured.promise;
        await store.patch(guildId, "levels", levelsSchema, {
            enabled: true,
            xp_gain: { min: 50, max: 60 },
        });
        release.resolve();
        expect((await oldRead).enabled).toBe(false);
        const fresh = await store.get(guildId, "levels", levelsSchema);
        expect(fresh.enabled).toBe(true);
        expect(fresh.xp_gain).toEqual({ min: 50, max: 60 });
    } finally {
        await db.close();
    }
}, 30000);
