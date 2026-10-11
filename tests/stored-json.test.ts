import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Database } from "../src/database/connection";
import { storedJsonObject } from "../src/database/json";
import { SettingsStore } from "../src/database/settings-store";
import { levelsSchema } from "../src/plugins/levels/config";
import { testDatabase } from "./helpers/database";

const bot = "100000000000000001";
const guild = "200000000000000001";
const channel = "400000000000000001";
const role = "500000000000000001";
let db: Database;
beforeAll(async () => {
  db = await testDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});

test("legacy JSON strings and spread character keys recover the latest named settings", () => {
  const original = {
    reward_channel_id: null,
    legacy_note: "Keep 🐇",
    reward_roles: [],
  };
  const expanded = {
    ...Object.fromEntries(Object.entries(JSON.stringify(original))),
    reward_channel_id: channel,
  };
  const repeated = {
    ...Object.fromEntries(Object.entries(JSON.stringify(expanded))),
    reward_roles: [{ level: 5, role_id: role }],
  };
  expect(storedJsonObject(JSON.stringify(repeated))).toEqual({
    legacy_note: "Keep 🐇",
    reward_channel_id: channel,
    reward_roles: [{ level: 5, role_id: role }],
  });
  expect(storedJsonObject(original)).toEqual(original);
  expect(storedJsonObject(JSON.stringify(JSON.stringify(original)))).toEqual(
    original,
  );
  expect(storedJsonObject({ "0": "legacy", unknown: true })).toEqual({
    "0": "legacy",
    unknown: true,
  });
});

test("invalid stored JSON fails closed instead of replacing it with defaults", () => {
  for (const invalid of [
    null,
    [],
    42,
    "broken",
    '"broken"',
    { "0": "{", "2": "}" },
  ]) {
    expect(() => storedJsonObject(invalid)).toThrow();
  }
  let tooDeep: unknown = {};
  for (let i = 0; i < 18; i++) tooDeep = JSON.stringify(tooDeep);
  expect(() => storedJsonObject(tooDeep)).toThrow("depth");
});

test("settings reads recover the announcement destination and writes compact the corrupted JSON", async () => {
  const original = {
    reward_channel_id: null,
    reward_roles: [],
    legacy_note: "retained",
  };
  const corrupt = JSON.stringify({
    ...Object.fromEntries(Object.entries(JSON.stringify(original))),
    reward_channel_id: channel,
  });
  await db.query(
    "insert into discord.plugins (bot_id,guild_id,plugin_name,enabled,config) values ($1,$2,'levels',true,$3::text::jsonb)",
    [bot, guild, JSON.stringify(corrupt)],
  );
  const store = new SettingsStore(db, bot);
  expect((await store.raw(guild, "levels")).config.reward_channel_id).toBe(
    channel,
  );
  expect(
    (await store.get(guild, "levels", levelsSchema)).reward_channel_id,
  ).toBe(channel);
  await store.patch(guild, "levels", levelsSchema, {
    reward_roles: [{ role_id: role, level: 5 }],
  });
  for (let i = 0; i < 4; i++) {
    await new SettingsStore(db, bot).patch(guild, "levels", levelsSchema, {
      xp_gain: { min: 16 + i },
    });
  }
  const saved = await new SettingsStore(db, bot).get(
    guild,
    "levels",
    levelsSchema,
  );
  expect(saved.reward_channel_id).toBe(channel);
  expect(saved.reward_roles).toEqual([{ level: 5, role_id: role }]);
  expect(saved.legacy_note).toBe("retained");
  const [row] = await db.query<{ kind: string; bytes: number }>(
    "select jsonb_typeof(config) as kind,octet_length(config::text) as bytes from discord.plugins where bot_id=$1 and guild_id=$2 and plugin_name='levels'",
    [bot, guild],
  );
  expect(row?.kind).toBe("object");
  expect(row?.bytes).toBeLessThan(1500);
});
