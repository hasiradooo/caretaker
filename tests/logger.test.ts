import { expect, test } from "bun:test";
import type { Guild } from "discord.js";
import type { Context } from "../src/core/plugin";
import { moderationLog } from "../src/plugins/moderation/log";
import {
  createLogger,
  type LogFields,
  type LoggerOptions,
} from "../src/shared/logger";

const instant = new Date("2026-10-11T09:56:28.260Z");
function capture(
  options: LoggerOptions = {},
  secrets: string[] = [],
  minimum: "info" | "warn" = "info",
) {
  const lines: string[] = [];
  const logger = createLogger("Caretaker", minimum, secrets, {
    format: "pretty",
    colors: false,
    timeZone: "Europe/Warsaw",
    now: () => instant,
    write: (line) => lines.push(line),
    ...options,
  });
  return { logger, lines };
}

test("successful quarantine logs show readable local time and indented details without an error", async () => {
  const { logger, lines } = capture();
  await moderationLog(
    { log: logger } as Context,
    { id: "server-id" } as Guild,
    null,
    "Quarantine role ban",
    "Account ID: member-id\nAccount type: Member\nBot guard: configured quarantine role",
  );
  expect(lines).toEqual([
    "2026-10-11 11:56:28  INFO   Caretaker  Quarantine role ban\n  Server: server-id\n  Account ID: member-id\n  Account type: Member\n  Bot guard: configured quarantine role",
  ]);
  expect(lines[0]).not.toContain("[object Object]");
  expect(lines[0]).not.toContain("Error:");
});

test("JSON keeps informational fields separate from real errors and retains UTC timestamps", async () => {
  const { logger, lines } = capture({ format: "json", colors: true });
  await moderationLog(
    { log: logger } as Context,
    { id: "server-id" } as Guild,
    null,
    "Quarantine role ban",
    "Account ID: member-id\nReason: quarantine role",
  );
  expect(JSON.parse(lines[0] ?? "")).toEqual({
    time: instant.toISOString(),
    level: "info",
    scope: "Caretaker",
    message: "Quarantine role ban",
    fields: {
      guildId: "server-id",
      detail: "Account ID: member-id\nReason: quarantine role",
    },
  });
  logger.error("Ban failed", new Error("Missing permissions"));
  expect(JSON.parse(lines[1] ?? "").error).toBe("Error: Missing permissions");
  expect(lines.join("\n")).not.toContain("\x1b[");
});

test.each([
  "pretty",
  "json",
] as const)("%s redacts credentials in nested fields, messages and errors", (format) => {
  const secret = 'private-credential-"quoted"';
  const bearer = "fake-discord-token-of-at-least-twenty-characters";
  const { logger, lines } = capture({ format }, [secret]);
  logger.info(`Details ${secret}`, {
    nested: [
      {
        password: secret,
        database: "postgres://user:password@db.invalid/database",
        authorization: `Bot ${bearer}`,
      },
    ],
  });
  logger.error("Failed", new Error(secret));
  const output = lines.join("\n");
  expect(output).toContain("[REDACTED]");
  expect(output).toContain("[DATABASE_URL]");
  expect(output).not.toContain("private-credential");
  expect(output).not.toContain("user:password");
  expect(output).not.toContain(bearer);
});

test("minimum level filters output and pretty logs keep multiline errors indented", () => {
  const { logger, lines } = capture({}, [], "warn");
  logger.debug("hidden debug", { detail: "hidden" });
  logger.info("hidden info");
  logger.warn("Permissions changed", new Error("first line\nsecond line"));
  logger.error("Failed", { code: 50013, message: "Missing permissions" });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain(
    "WARN   Caretaker  Permissions changed\n  Error: first line\n  second line",
  );
  expect(lines[1]).toContain('"code": 50013');
  expect(lines.join("\n")).not.toContain("[object Object]");
});

test.each([
  "pretty",
  "json",
] as const)("%s supports circular metadata and bigint IDs without throwing", (format) => {
  const fields: LogFields = { id: 123456789012345678n };
  fields.self = fields;
  const { logger, lines } = capture({ format });
  expect(() => logger.info("Details", fields)).not.toThrow();
  expect(lines[0]).toContain("123456789012345678");
  expect(lines[0]).toContain("[Circular]");
  logger.info("Still running", {
    toJSON() {
      throw new Error("Do not print me");
    },
  });
  expect(lines[1]).toContain("[Unserializable log value]");
  expect(lines[1]).not.toContain("Do not print me");
});

test("pretty terminal output strips injected escape sequences and colors only its own labels", () => {
  const plain = capture();
  plain.logger.info("Ready\x1b[2J\rForged header", {
    detail: "\x1b[31munsafe\x1b[0m\nsecond line",
  });
  expect(plain.lines[0]).not.toContain("\x1b");
  expect(plain.lines[0]).toContain("Ready\n  Forged header");
  expect(plain.lines[0]).toContain("\n  unsafe\n  second line");
  const colored = capture({ colors: true });
  colored.logger.info("Ready");
  expect(colored.lines[0]).toContain("\x1b[36mINFO ");
});

test("invalid optional timezones do not prevent startup logging", () => {
  const { logger, lines } = capture({ timeZone: "invalid/timezone" });
  expect(() => logger.info("Ready")).not.toThrow();
  expect(lines[0]).toContain("INFO   Caretaker  Ready");
});
