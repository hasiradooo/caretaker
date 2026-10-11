import { expect, mock, test } from "bun:test";
import {
  type ClientEvents,
  Collection,
  Events,
  type GuildMember,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context, EventRegistrar } from "../src/core/plugin";
import { createBotGuardPlugin } from "../src/plugins/bot-guard";
import { botGuardSchema } from "../src/plugins/bot-guard/config";

const botId = "100000000000000001",
  guildId = "200000000000000001",
  roleId = "500000000000000001",
  targetId = "300000000000000001";
function fixture(config = {}) {
  const handlers: Partial<{
    [K in keyof ClientEvents]: (...args: ClientEvents[K]) => Promise<void>;
  }> = {};
  let tick = async () => {};
  const events: EventRegistrar = {
    on(event, handler) {
      Object.assign(handlers, { [event]: handler });
    },
    every(_ms, task) {
      tick = task;
    },
  };
  const held = new Set<string>();
  const listed = new Collection<string, GuildMember>();
  let now = 0;
  const guild = {
    id: guildId,
    ownerId: "owner",
    members: {
      me: {
        permissions: new PermissionsBitField(PermissionFlagsBits.BanMembers),
      },
      cache: new Collection<string, unknown>(),
      fetch: mock(
        async (_options: {
          user: string;
          force: boolean;
          cache: boolean;
        }): Promise<GuildMember> => member as unknown as GuildMember,
      ),
      list: mock(
        async (_options: {
          limit: number;
          cache: boolean;
          after?: string;
        }): Promise<Collection<string, GuildMember>> => new Collection(listed),
      ),
    },
  };
  const member = {
    id: targetId,
    user: { bot: true },
    guild,
    joinedTimestamp: 1,
    bannable: true,
    roles: { cache: new Collection<string, { id: string }>() },
    ban: mock(async (_options: unknown) => undefined),
  };
  guild.members.cache.set(targetId, member);
  listed.set(targetId, member as unknown as GuildMember);
  const settings = botGuardSchema.parse({
    enabled: true,
    ban_on_join: true,
    ...config,
  });
  const context = {
    botId,
    settings: { get: mock(async () => settings) },
    state: {
      claim: mock(async (_g: string, _p: string, key: string) => {
        if (held.has(key)) return false;
        held.add(key);
        return true;
      }),
      release: mock(async (_g: string, _p: string, key: string) => {
        held.delete(key);
      }),
    },
    client: { guilds: { cache: new Collection([[guildId, guild]]) } },
    log: { info: mock(() => {}), warn: mock(() => {}) },
  };
  const plugin = createBotGuardPlugin(() => now);
  plugin.register?.(context as unknown as Context, events);
  const join = () =>
    handlers[Events.GuildMemberAdd]?.(member as unknown as GuildMember);
  const update = () =>
    handlers[Events.GuildMemberUpdate]?.(
      member as unknown as GuildMember,
      member as unknown as GuildMember,
    );
  return {
    member,
    guild,
    context,
    settings,
    join,
    update,
    listed,
    tick: () => tick(),
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}
test("bot guard defaults retain opt-in quarantine behavior", () => {
  expect(botGuardSchema.parse({})).toMatchObject({
    enabled: false,
    ban_on_join: false,
    quarantine_targets: "bots",
    watch_roles: [],
    allowed_bot_ids: [],
    delete_message_days: 0,
  });
});
test("unapproved bot joins are banned once with configured history removal", async () => {
  const f = fixture({ delete_message_days: 2 });
  await Promise.all([f.join(), f.join()]);
  expect(f.member.ban).toHaveBeenCalledTimes(1);
  expect(f.member.ban).toHaveBeenCalledWith({
    reason: "Bot guard: unapproved bot joined",
    deleteMessageSeconds: 172800,
  });
  f.member.joinedTimestamp = 2;
  await f.join();
  expect(f.member.ban).toHaveBeenCalledTimes(2);
});
test("humans, self, allowed bots and unreachable hierarchy are never banned", async () => {
  for (const kind of [
    "human",
    "self",
    "allowed",
    "hierarchy",
    "permissions",
    "disabled",
  ]) {
    const f = fixture();
    if (kind === "human") f.member.user.bot = false;
    if (kind === "self") f.member.id = botId;
    if (kind === "allowed") f.settings.allowed_bot_ids.push(targetId);
    if (kind === "hierarchy") f.member.bannable = false;
    if (kind === "permissions")
      f.guild.members.me.permissions = new PermissionsBitField();
    if (kind === "disabled") f.settings.enabled = false;
    await f.join();
    expect(f.member.ban).not.toHaveBeenCalled();
  }
});
test("join protection never sweeps installed bots, but quarantine checks still work", async () => {
  const f = fixture();
  await f.update();
  await f.tick();
  expect(f.member.ban).not.toHaveBeenCalled();
  const quarantined = fixture({ ban_on_join: false, watch_roles: [roleId] });
  quarantined.member.roles.cache.set(roleId, { id: roleId });
  await quarantined.tick();
  expect(quarantined.member.ban).toHaveBeenCalledWith({
    reason: "Bot guard: configured quarantine role",
    deleteMessageSeconds: 0,
  });
});
test("failed bans release their claim for retry and never report success", async () => {
  const f = fixture();
  f.member.ban.mockRejectedValueOnce(new Error("Discord unavailable"));
  await expect(f.join()).rejects.toThrow("Discord unavailable");
  expect(f.context.log.info).not.toHaveBeenCalled();
  await f.join();
  expect(f.member.ban).toHaveBeenCalledTimes(2);
});

test("all-account quarantine bans a regular member immediately on role assignment", async () => {
  const f = fixture({
    ban_on_join: false,
    watch_roles: [roleId],
    quarantine_targets: "all",
  });
  f.member.user.bot = false;
  f.member.roles.cache.set(roleId, { id: roleId });
  await f.update();
  expect(f.member.ban).toHaveBeenCalledTimes(1);
  expect(f.guild.members.fetch).toHaveBeenCalledWith({
    user: targetId,
    force: true,
    cache: false,
  });
  expect(f.member.ban).toHaveBeenCalledWith({
    reason: "Bot guard: configured quarantine role",
    deleteMessageSeconds: 0,
  });
});

test("regular members without quarantine roles are never banned by bot join protection", async () => {
  const f = fixture({ watch_roles: [roleId], quarantine_targets: "all" });
  f.member.user.bot = false;
  await f.join();
  await f.update();
  await f.tick();
  expect(f.member.ban).not.toHaveBeenCalled();
});

test("all-account quarantine retains owner, self, allowlist, permission and hierarchy protections", async () => {
  for (const kind of [
    "owner",
    "self",
    "allowed",
    "permissions",
    "hierarchy",
    "everyone",
    "disabled",
    "bots-only",
  ]) {
    const f = fixture({
      ban_on_join: false,
      watch_roles: [roleId],
      quarantine_targets: "all",
    });
    f.member.user.bot = false;
    f.member.roles.cache.set(roleId, { id: roleId });
    if (kind === "owner") f.guild.ownerId = targetId;
    if (kind === "self") f.member.id = botId;
    if (kind === "allowed") f.settings.allowed_bot_ids.push(targetId);
    if (kind === "permissions")
      f.guild.members.me.permissions = new PermissionsBitField();
    if (kind === "hierarchy") f.member.bannable = false;
    if (kind === "everyone") {
      f.settings.watch_roles = [guildId];
      f.member.roles.cache.set(guildId, { id: guildId });
    }
    if (kind === "disabled") f.settings.enabled = false;
    if (kind === "bots-only") f.settings.quarantine_targets = "bots";
    await f.update();
    await f.tick();
    expect(f.member.ban).not.toHaveBeenCalled();
  }
});

test("periodic scans find uncached members and obey the one-minute check interval", async () => {
  const f = fixture({
    ban_on_join: false,
    watch_roles: [roleId],
    quarantine_targets: "all",
    ban_check_interval_minutes: 1,
  });
  f.member.user.bot = false;
  f.member.roles.cache.set(roleId, { id: roleId });
  f.guild.members.cache.clear();
  await f.tick();
  expect(f.member.ban).toHaveBeenCalledTimes(1);
  expect(f.guild.members.list).toHaveBeenCalledWith({
    limit: 1000,
    cache: false,
  });
  f.advance(59999);
  await f.tick();
  expect(f.guild.members.list).toHaveBeenCalledTimes(1);
  f.advance(1);
  await f.tick();
  expect(f.guild.members.list).toHaveBeenCalledTimes(2);
  expect(f.member.ban).toHaveBeenCalledTimes(1);
});

test("a role removed before a queued check and a departed member are not banned", async () => {
  const f = fixture({
    ban_on_join: false,
    watch_roles: [roleId],
    quarantine_targets: "all",
  });
  f.member.user.bot = false;
  f.member.roles.cache.set(roleId, { id: roleId });
  f.guild.members.fetch.mockResolvedValueOnce({
    ...f.member,
    roles: { cache: new Collection() },
  } as unknown as GuildMember);
  await f.update();
  f.guild.members.fetch.mockRejectedValueOnce({ code: 10007 });
  await f.update();
  expect(f.member.ban).not.toHaveBeenCalled();
  expect(f.context.state.claim).not.toHaveBeenCalled();
});

test("time spent fetching members does not turn a one-minute interval into two minutes", async () => {
  const f = fixture({
    ban_on_join: false,
    watch_roles: [roleId],
    ban_check_interval_minutes: 1,
  });
  f.guild.members.list.mockImplementationOnce(async () => {
    f.advance(3000);
    return new Collection(f.listed);
  });
  await f.tick();
  f.advance(57000);
  await f.tick();
  expect(f.guild.members.list).toHaveBeenCalledTimes(2);
});

test("scans paginate beyond the first thousand members and never scan for join protection alone", async () => {
  const f = fixture({
    ban_on_join: false,
    watch_roles: [roleId],
    quarantine_targets: "all",
  });
  const firstPage = new Collection<string, GuildMember>();
  for (let i = 0; i < 1000; i++) {
    const id = String(200000000000000000n + BigInt(i));
    firstPage.set(id, {
      ...f.member,
      id,
      roles: { cache: new Collection() },
    } as unknown as GuildMember);
  }
  f.member.roles.cache.set(roleId, { id: roleId });
  f.guild.members.list.mockResolvedValueOnce(firstPage);
  await f.tick();
  expect(f.guild.members.list.mock.calls[1]?.[0].after).toBe(
    firstPage.lastKey(),
  );
  expect(f.member.ban).toHaveBeenCalledTimes(1);
  const joinOnly = fixture();
  await joinOnly.tick();
  expect(joinOnly.guild.members.list).not.toHaveBeenCalled();
});
