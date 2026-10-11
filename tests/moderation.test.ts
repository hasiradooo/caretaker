import { expect, mock, test } from "bun:test";
import {
  Collection,
  type Message,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import { moderationSchema, ruleSchema } from "../src/plugins/moderation/config";
import { conditionMatches, linkHosts } from "../src/plugins/moderation/rules";
import { ModerationService } from "../src/plugins/moderation/service";

const botId = "100000000000000001",
  guildId = "200000000000000001",
  userId = "300000000000000001",
  channelId = "400000000000000001",
  roleId = "500000000000000001";
const makeRule = (patch = {}) =>
  ruleSchema.parse({
    id: crypto.randomUUID(),
    name: "Custom rule",
    enabled: true,
    ...patch,
  });
const facts = (content: string) => ({
  content,
  attachments: 0,
  mentionCount: 0,
  everyone: false,
});

test("new moderation is inert and invalid rule configurations fail validation", () => {
  expect(moderationSchema.parse({})).toMatchObject({
    enabled: false,
    rules: [],
    exempt_staff: true,
    include_bots: false,
  });
  expect(() => makeRule({ condition: "words" })).toThrow();
  expect(() => makeRule({ condition: "words", values: ["\u200b"] })).toThrow(
    "visible",
  );
  expect(() =>
    makeRule({ condition: "words", values: Array(50).fill("a".repeat(100)) }),
  ).toThrow("4,000");
  expect(() =>
    makeRule({ condition: "domains", values: ["https://example.com"] }),
  ).toThrow();
  expect(() => makeRule({ timeout_minutes: 40321 })).toThrow();
  const rule = makeRule();
  expect(() => moderationSchema.parse({ rules: [rule, rule] })).toThrow(
    "unique",
  );
  expect(() =>
    moderationSchema.parse({
      enabled: true,
      rules: [makeRule({ action: "log" })],
    }),
  ).toThrow("log channel");
});
test.each([
  "https://example.com/x",
  "[normal text](https://example.com/nsfw)",
  "<https://example.com>",
  "www.example.com",
  "example.com/path",
  "https://127.0.0.1/a",
  "ｈｔｔｐｓ://example.com",
  "https://exa\u200bmple.com",
])("link condition detects %s without opening it", (content) => {
  expect(conditionMatches(makeRule(), facts(content))).toBe(true);
});
test("custom conditions have exact domain boundaries, literal phrases and attachment/mention thresholds", () => {
  expect(conditionMatches(makeRule(), facts("just normal text"))).toBe(false);
  const domains = makeRule({ condition: "domains", values: ["example.com"] });
  expect(conditionMatches(domains, facts("https://sub.example.com/x"))).toBe(
    true,
  );
  expect(conditionMatches(domains, facts("https://example.com.evil.org"))).toBe(
    false,
  );
  expect(conditionMatches(domains, facts("https://notexample.com"))).toBe(
    false,
  );
  expect(conditionMatches(domains, facts("https://example.com@evil.org"))).toBe(
    false,
  );
  expect(linkHosts("https://münich.example")).toContain(
    "xn--mnich-kva.example",
  );
  expect(
    conditionMatches(
      makeRule({ condition: "words", values: ["BAD phrase"] }),
      facts("a bad PHRASE here"),
    ),
  ).toBe(true);
  expect(
    conditionMatches(
      makeRule({ condition: "words", values: ["a.*b"] }),
      facts("axxxb"),
    ),
  ).toBe(false);
  expect(
    conditionMatches(
      makeRule({ condition: "invites" }),
      facts("https://discord.com/invite/abc"),
    ),
  ).toBe(true);
  expect(
    conditionMatches(
      makeRule({ condition: "invites" }),
      facts("https://notdiscord.gg/abc"),
    ),
  ).toBe(false);
  expect(
    conditionMatches(makeRule({ condition: "attachments" }), {
      ...facts(""),
      attachments: 1,
    }),
  ).toBe(true);
  const mentions = makeRule({ condition: "mentions", mention_limit: 5 });
  expect(conditionMatches(mentions, { ...facts(""), mentionCount: 4 })).toBe(
    false,
  );
  expect(conditionMatches(mentions, { ...facts(""), mentionCount: 5 })).toBe(
    true,
  );
  expect(conditionMatches(mentions, { ...facts(""), everyone: true })).toBe(
    true,
  );
});

function fixture(patch = {}) {
  let config = moderationSchema.parse({
    enabled: true,
    rules: [makeRule()],
    ...patch,
  });
  const claimed = new Set<string>();
  const claim = mock(async (guild: string, plugin: string, key: string) => {
    const id = `${guild}:${plugin}:${key}`;
    if (claimed.has(id)) return false;
    claimed.add(id);
    return true;
  });
  const release = mock(async (guild: string, plugin: string, key: string) => {
    claimed.delete(`${guild}:${plugin}:${key}`);
  });
  const member = {
    id: userId,
    roles: { cache: new Collection<string, { id: string }>() },
    permissions: new PermissionsBitField(),
    moderatable: true,
    communicationDisabledUntilTimestamp: 0,
    disableCommunicationUntil: mock(
      async (_date: Date, _reason: string) => undefined,
    ),
  };
  const send = mock(async (_payload: unknown) => undefined);
  const channel = {
    id: channelId,
    type: 0,
    isThread: () => false,
    parentId: null as string | null,
    isSendable: () => true,
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory,
        PermissionFlagsBits.ManageMessages,
      ]),
    send,
  };
  const guild = {
    id: guildId,
    ownerId: "owner",
    members: {
      me: {
        permissions: new PermissionsBitField(
          PermissionFlagsBits.ManageMessages,
        ),
      },
      fetch: mock(async (_id: string) => member),
    },
    channels: { fetch: mock(async (_id: string) => channel) },
  };
  const message = {
    id: "600000000000000001",
    guild,
    guildId,
    channelId,
    channel,
    author: { id: userId, bot: false },
    webhookId: null as string | null,
    system: false,
    content: "https://example.com/bad",
    createdTimestamp: Date.now() - 365 * 86400000,
    partial: false,
    inGuild: () => true,
    deletable: true,
    attachments: new Collection<string, object>(),
    mentions: {
      users: new Collection(),
      roles: new Collection(),
      everyone: false,
    },
    delete: mock(async () => undefined),
    fetch: mock(async (_force?: boolean): Promise<unknown> => message),
  };
  const log = {
    info: mock((_title: string, _data?: unknown) => undefined),
    warn: mock((_title: string, _error?: unknown) => undefined),
  };
  const get = mock(async (_guild: string, _plugin: string) => config);
  const context = {
    botId,
    settings: { get },
    state: { claim, release },
    log,
  } as unknown as Context;
  const service = new ModerationService(context);
  const check = (event: "create" | "edit" = "edit", value: unknown = message) =>
    service.check(value as Message, event);
  return {
    message,
    member,
    guild,
    channel,
    send,
    check,
    get,
    claim,
    release,
    log,
    service,
    setConfig: (patch: Record<string, unknown>) => {
      config = moderationSchema.parse({ ...config, ...patch });
    },
  };
}
test("old uncached edits fetch the current message, delete it once, and do not act on creation", async () => {
  const f = fixture();
  await f.check("create");
  expect(f.message.delete).not.toHaveBeenCalled();
  const partial = { ...f.message, author: null, partial: true, content: null };
  await Promise.all([f.check("edit", partial), f.check("edit", partial)]);
  expect(f.message.fetch).toHaveBeenCalledWith(true);
  expect(f.message.delete).toHaveBeenCalledTimes(1);
  expect(f.get).toHaveBeenCalledWith(guildId, "moderation", moderationSchema);
  expect(f.member.disableCommunicationUntil).not.toHaveBeenCalled();
  expect(JSON.stringify(f.log.info.mock.calls)).not.toContain("example.com");
});
test("newer clean content wins over an earlier malicious edit", async () => {
  const f = fixture();
  const stale = { ...f.message, content: "https://example.com" };
  f.message.content = "now clean";
  await f.check("edit", stale);
  expect(f.message.delete).not.toHaveBeenCalled();
});
test("missing messages are ignored, inaccessible fetches are reported, and disabled rules do not fetch", async () => {
  const f = fixture();
  f.message.fetch.mockRejectedValueOnce({ code: 10008 });
  await f.check();
  expect(f.log.warn).not.toHaveBeenCalled();
  f.message.fetch.mockRejectedValueOnce({ code: 50001 });
  await f.check();
  expect(f.log.warn).toHaveBeenCalledTimes(1);
  f.setConfig({ enabled: false });
  await f.check();
  expect(f.message.fetch).toHaveBeenCalledTimes(2);
  expect(f.message.delete).not.toHaveBeenCalled();
});
test("exceptions, role scopes, staff, owner, bots and webhooks are honored", async () => {
  for (const kind of [
    "role",
    "channel",
    "staff",
    "owner",
    "bot",
    "webhook",
    "self",
    "scope",
  ]) {
    const f = fixture();
    if (kind === "role") {
      f.setConfig({ exempt_roles: [roleId] });
      f.member.roles.cache.set(roleId, { id: roleId });
    }
    if (kind === "channel") {
      f.setConfig({ exempt_channels: [channelId] });
      f.message.channelId = "400000000000000002";
      f.channel.isThread = () => true;
      f.channel.parentId = channelId;
    }
    if (kind === "staff")
      f.member.permissions.add(PermissionFlagsBits.ManageMessages);
    if (kind === "owner") f.guild.ownerId = userId;
    if (kind === "bot") f.message.author.bot = true;
    if (kind === "webhook") f.message.webhookId = "webhook";
    if (kind === "self") f.message.author.id = botId;
    if (kind === "scope")
      f.setConfig({ rules: [makeRule({ roles: [roleId] })] });
    await f.check();
    expect(f.message.delete).not.toHaveBeenCalled();
  }
});

test("member lookup failures never bypass exemptions and are reported unless the member left", async () => {
  const f = fixture();
  f.guild.members.fetch.mockRejectedValueOnce({ code: 50001 });
  await f.check();
  expect(f.log.warn).toHaveBeenCalledTimes(1);
  expect(f.message.delete).not.toHaveBeenCalled();
  f.guild.members.fetch.mockRejectedValueOnce({ code: 10007 });
  await f.check();
  expect(f.log.warn).toHaveBeenCalledTimes(1);
  expect(f.message.delete).not.toHaveBeenCalled();
});
test("channel scopes include threads and opted-in bots/webhooks can be checked", async () => {
  const f = fixture({
    rules: [makeRule({ channels: [channelId] })],
    include_bots: true,
  });
  f.message.channelId = "400000000000000002";
  f.channel.isThread = () => true;
  f.channel.parentId = channelId;
  f.message.author.bot = true;
  f.message.webhookId = "webhook";
  await f.check();
  expect(f.message.delete).toHaveBeenCalledTimes(1);
});
test("multiple rules delete once and use the longest timeout without shortening an existing one", async () => {
  const f = fixture({
    rules: [
      makeRule({ action: "delete_timeout", timeout_minutes: 10 }),
      makeRule({ action: "delete_timeout", timeout_minutes: 60 }),
    ],
  });
  await f.check();
  expect(f.message.delete).toHaveBeenCalledTimes(1);
  expect(f.member.disableCommunicationUntil).toHaveBeenCalledTimes(1);
  expect(
    f.member.disableCommunicationUntil.mock.calls[0]?.[0].getTime(),
  ).toBeGreaterThan(Date.now() + 59 * 60000);
  const second = fixture({ rules: [makeRule({ action: "delete_timeout" })] });
  second.member.communicationDisabledUntilTimestamp = Date.now() + 86400000;
  await second.check();
  expect(second.member.disableCommunicationUntil).not.toHaveBeenCalled();
});
test("failed deletion never times out and can retry; timeout failure does not undo deletion", async () => {
  const f = fixture({ rules: [makeRule({ action: "delete_timeout" })] });
  f.message.delete.mockRejectedValueOnce(new Error("Missing permissions"));
  await f.check();
  expect(f.member.disableCommunicationUntil).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledTimes(1);
  f.member.moderatable = false;
  await f.check();
  expect(f.message.delete).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(f.log.info.mock.calls)).toContain("Timeout failed");
});
test("log-only rules are deduplicated and never copy removed content into logs", async () => {
  const f = fixture({
    log_channel_id: channelId,
    rules: [makeRule({ action: "log" })],
  });
  await f.check();
  await f.check();
  expect(f.message.delete).not.toHaveBeenCalled();
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(f.send.mock.calls)).not.toContain("example.com");
  expect(f.send.mock.calls[0]?.[0]).toMatchObject({
    allowedMentions: { parse: [] },
  });
});
