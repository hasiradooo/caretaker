import { describe, expect, test } from "bun:test";
import { readEnvironment } from "../src/config/environment";
import type { Context } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import { decryptToken, encryptToken } from "../src/database/encryption";
import { createPlugins } from "../src/plugins";
import { isBirthday, localDate } from "../src/plugins/birthday/dates";
import { messageXp, splitXp, totalXp } from "../src/plugins/levels/math";
import { renderTemplate } from "../src/shared/templates";
import { mergeSettings, pathPatch } from "../src/shared/validation";

describe("level arithmetic", () => {
  test("matches the legacy growing per-level cost at boundaries", () => {
    expect(splitXp(0)).toEqual({ level: 0, xp: 0 });
    expect(splitXp(2999)).toEqual({ level: 0, xp: 2999 });
    expect(splitXp(3000)).toEqual({ level: 1, xp: 0 });
    expect(splitXp(9000)).toEqual({ level: 2, xp: 0 });
    for (let level = 0; level < 1000; level++) {
      expect(splitXp(totalXp(level, level))).toEqual({ level, xp: level });
    }
  });
  test("rejects invalid XP and honours configured inclusive gain and multipliers", () => {
    for (const value of [
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      0.1,
      2_000_000_001,
    ])
      expect(() => splitXp(value)).toThrow();
    expect(messageXp(15, 25, 2, () => 0)).toBe(30);
    expect(messageXp(15, 25, 2, () => 0.99999)).toBe(50);
  });
});

test("template replacement is literal and never evaluates member-provided placeholders", () => {
  expect(
    renderTemplate("Hello {display_name}; {user}", {
      display_name: "{user} $&",
      user: "Kiro",
    }),
  ).toBe("Hello {user} $&; Kiro");
});

test("deep configuration patches reject prototype pollution", () => {
  expect(() =>
    mergeSettings({}, JSON.parse('{"nested":{"__proto__":{"admin":true}}}')),
  ).toThrow();
  expect(() => pathPatch("constructor.prototype.admin", true)).toThrow();
  expect(pathPatch("xp_gain.min", 20)).toEqual({ xp_gain: { min: 20 } });
});

test("calendar validation includes leap years and time zones", () => {
  expect(isBirthday(29, 2)).toBe(true);
  expect(isBirthday(29, 2, 2025)).toBe(false);
  expect(isBirthday(31, 4)).toBe(false);
  expect(
    localDate(new Date("2026-10-10T22:30:00Z"), "Europe/Warsaw"),
  ).toMatchObject({ day: 11, month: 10, hour: 0 });
});

test("token encryption preserves the old envelope and rejects tampering", () => {
  const key = "1a".repeat(32);
  const encrypted = encryptToken("test-token", key);
  expect(encrypted.split(":")).toHaveLength(3);
  expect(decryptToken(encrypted, key)).toBe("test-token");
  expect(() => decryptToken(encrypted, "2b".repeat(32))).toThrow();
  expect(() => encryptToken("test", "z".repeat(64))).toThrow();
  expect(() => decryptToken("wrong", key)).toThrow();
});

test("HTTP cannot be enabled without a strong secret", () => {
  const input = {
    DISCORD_TOKEN: "test-only",
    DISCORD_CLIENT_ID: "100000000000000001",
    DATABASE_URL: "postgres://localhost/test",
    MASTER_ENCRYPTION_KEY: "ab".repeat(32),
  };
  expect(readEnvironment(input).HTTP_ENABLED).toBe(false);
  expect(() => readEnvironment({ ...input, HTTP_ENABLED: "true" })).toThrow(
    "API_SECRET_KEY",
  );
  expect(() => readEnvironment({ ...input, PORT: "invalid" })).toThrow("PORT");
});

test("every plugin has valid isolated defaults and serializable commands", () => {
  const plugins = createPlugins();
  for (const plugin of plugins) {
    const first = plugin.schema.parse({});
    if (plugin.id !== "configuration") expect(first.enabled).toBe(false);
    first.enabled = true;
    if (plugin.id !== "configuration")
      expect(plugin.schema.parse({}).enabled).toBe(false);
    for (const command of plugin.commands ?? [])
      expect(command.data.toJSON().name).toMatch(/^[a-z]+$/);
  }
  expect(
    () =>
      new PluginRuntime({} as Context, [
        ...plugins,
        plugins[0] as NonNullable<(typeof plugins)[0]>,
      ]),
  ).toThrow("Duplicate");
});
