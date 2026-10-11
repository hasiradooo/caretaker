import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  type ChatInputCommandInteraction,
  type ClientEvents,
  Collection,
  Events,
  type GuildMember,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type Role,
} from "discord.js";
import type { Context, EventRegistrar } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { levelsPlugin } from "../src/plugins/levels";
import { levelsSchema } from "../src/plugins/levels/config";
import { LevelsRepository } from "../src/plugins/levels/repository";
import { syncLevelRewards } from "../src/plugins/levels/rewards";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001";
const guildId = "200000000000000001";
const userId = "300000000000000001";
const role5 = "400000000000000005";
const role10 = "400000000000000010";
const role15 = "400000000000000015";
const unrelated = "400000000000000099";
const milestoneRoles = [
  { level: 5, role_id: role5 },
  { level: 10, role_id: role10 },
  { level: 15, role_id: role15 },
];

let db: Database;
beforeAll(async () => {
  db = await testDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});

function fixture(held: string[] = []) {
  const calls: string[] = [];
  const roles = new Map<string, Role>();
  for (const id of [role5, role10, role15, unrelated]) {
    roles.set(id, {
      id,
      managed: false,
      permissions: new PermissionsBitField(),
      comparePositionTo: () => -1,
    } as unknown as Role);
  }
  const cache = new Collection(
    held.map((id) => {
      const role = roles.get(id);
      if (!role) throw new Error(`Missing fixture role ${id}`);
      return [id, role] as const;
    }),
  );
  const add = mock(async (role: Role) => {
    calls.push(`add:${role.id}`);
    cache.set(role.id, role);
  });
  const remove = mock(async (role: Role) => {
    calls.push(`remove:${role.id}`);
    cache.delete(role.id);
  });
  const guild = {
    id: guildId,
    roles: { fetch: mock(async (id: string) => roles.get(id) ?? null) },
    members: {
      me: {
        roles: { highest: {} },
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
      },
      fetch: mock(async (_options: unknown): Promise<GuildMember> => member),
    },
  };
  const member = {
    id: userId,
    user: { id: userId, bot: false },
    displayName: "Milestone explorer",
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
    guild,
    roles: { cache, add, remove },
  } as unknown as GuildMember;
  const warn = mock(() => undefined);
  return {
    member,
    guild,
    roles,
    add,
    remove,
    calls,
    warn,
    log: {
      warn,
      error: mock(() => undefined),
      info: mock(() => undefined),
      debug: mock(() => undefined),
    },
  };
}

function commandInteraction(
  guild: ReturnType<typeof fixture>["guild"],
  action: string,
  options: {
    level?: number;
    role?: string;
    page?: number;
    admin?: boolean;
  } = {},
) {
  const editReply = mock(async (_payload: unknown) => undefined);
  const value = {
    guildId: guild.id,
    guild,
    commandName: "level",
    user: { id: userId },
    memberPermissions: new PermissionsBitField(
      options.admin === false ? [] : [PermissionFlagsBits.ManageGuild],
    ),
    options: {
      getSubcommandGroup: () => "rewards",
      getSubcommand: () => action,
      getInteger: (name: string) =>
        name === "page" ? (options.page ?? null) : (options.level ?? null),
      getRole: () => (options.role ? { id: options.role } : null),
    },
    editReply,
  };
  return {
    value: value as unknown as ChatInputCommandInteraction<"cached">,
    editReply,
  };
}

function execute(
  context: Context,
  interaction: ChatInputCommandInteraction<"cached">,
) {
  const command = levelsPlugin.commands?.[0];
  if (!command) throw new Error("Missing levels command");
  return command.execute(context, interaction);
}

test("reward commands stay private and deny non-admins before accessing settings", async () => {
  const f = fixture();
  for (const action of ["add", "remove", "list"]) {
    const interaction = commandInteraction(f.guild, action, { admin: false });
    const raw = mock(async () => undefined);
    await expect(
      execute({ settings: { raw } } as unknown as Context, interaction.value),
    ).rejects.toThrow("Manage Server");
    expect(raw).not.toHaveBeenCalled();
    const deferReply = mock(async (_payload: unknown) => undefined);
    await new PluginRuntime({ log: f.log } as unknown as Context, [
      {
        ...levelsPlugin,
        commands: levelsPlugin.commands?.map((command) => ({
          ...command,
          execute: async () => {},
        })),
      },
    ]).dispatch({
      ...interaction.value,
      isRepliable: () => true,
      inCachedGuild: () => true,
      isChatInputCommand: () => true,
      deferReply,
    } as unknown as ChatInputCommandInteraction);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  }
});

test("admins add and move milestone roles without replacing other settings or enabling levels", async () => {
  const f = fixture();
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "levels", levelsSchema, {
    enabled: false,
    reward_channel_id: "500000000000000001",
    xp_gain: { min: 20, max: 25 },
    legacy_note: "preserved",
    reward_roles: [],
  });
  const context = { settings } as unknown as Context;
  for (const item of milestoneRoles) {
    await execute(
      context,
      commandInteraction(f.guild, "add", {
        level: item.level,
        role: item.role_id,
      }).value,
    );
  }
  const edited = commandInteraction(f.guild, "add", {
    level: 12,
    role: role10,
  });
  await execute(context, edited.value);
  const saved = await settings.get(guildId, "levels", levelsSchema);
  expect(saved).toMatchObject({
    enabled: false,
    reward_channel_id: "500000000000000001",
    xp_gain: { min: 20, max: 25 },
    legacy_note: "preserved",
  });
  expect(saved.reward_roles).toEqual([
    { level: 5, role_id: role5 },
    { level: 12, role_id: role10 },
    { level: 15, role_id: role15 },
  ]);
  const payload = edited.editReply.mock.calls[0]?.[0];
  expect(payload).toMatchObject({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false },
  });
  expect(JSON.stringify(payload)).not.toContain('"embeds"');
  expect(componentText(payload)).toContain("Levels are disabled");
  expect(
    (
      await new SettingsStore(db, botId).get(
        "200000000000000002",
        "levels",
        levelsSchema,
      )
    ).reward_roles,
  ).toEqual([]);
  expect(
    (
      await new SettingsStore(db, "100000000000000002").get(
        guildId,
        "levels",
        levelsSchema,
      )
    ).reward_roles,
  ).toEqual([]);
});

test("setup rejects missing, managed, privileged and unreachable roles before saving", async () => {
  const f = fixture();
  const patch = mock(async () => undefined);
  const context = {
    settings: {
      raw: async () => ({ enabled: false, config: {}, revision: null }),
      patch,
    },
  } as unknown as Context;
  const role = f.roles.get(role5);
  if (!role) throw new Error("Missing fixture role");
  for (const invalid of [
    { managed: true },
    {
      managed: false,
      permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    },
    { permissions: new PermissionsBitField(), comparePositionTo: () => 0 },
  ]) {
    Object.assign(role, invalid);
    await expect(
      execute(
        context,
        commandInteraction(f.guild, "add", { level: 5, role: role5 }).value,
      ),
    ).rejects.toThrow("cannot be assigned");
  }
  f.roles.delete(role5);
  await expect(
    execute(
      context,
      commandInteraction(f.guild, "add", { level: 5, role: role5 }).value,
    ),
  ).rejects.toThrow("cannot be assigned");
  expect(patch).not.toHaveBeenCalled();
});

test("removal supports one tied reward or a whole milestone, including deleted roles", async () => {
  const f = fixture();
  const settings = new SettingsStore(db, botId);
  const context = { settings } as unknown as Context;
  await settings.patch(guildId, "levels", levelsSchema, {
    reward_roles: [
      { level: 5, role_id: role5 },
      { level: 5, role_id: role10 },
      { level: 15, role_id: role15 },
    ],
  });
  await execute(
    context,
    commandInteraction(f.guild, "remove", { level: 5, role: role5 }).value,
  );
  expect(
    (await settings.get(guildId, "levels", levelsSchema)).reward_roles,
  ).toHaveLength(2);
  f.roles.delete(role10);
  await execute(
    context,
    commandInteraction(f.guild, "remove", { level: 5 }).value,
  );
  expect(
    (await settings.get(guildId, "levels", levelsSchema)).reward_roles,
  ).toEqual([{ level: 15, role_id: role15 }]);
  await expect(
    execute(context, commandInteraction(f.guild, "remove", { level: 5 }).value),
  ).rejects.toThrow("No matching");
  expect(f.remove).not.toHaveBeenCalled();
});

test("reward lists paginate and sort without mentioning roles or accessing member roles", async () => {
  const f = fixture();
  const reward_roles = Array.from({ length: 100 }, (_, i) => ({
    level: 100 - i,
    role_id: String(BigInt(role5) + BigInt(i)),
  }));
  const context = {
    settings: {
      raw: async () => ({
        enabled: true,
        config: { reward_roles },
        revision: "revision",
      }),
    },
  } as unknown as Context;
  const interaction = commandInteraction(f.guild, "list", { page: 10 });
  await execute(context, interaction.value);
  const payload = interaction.editReply.mock.calls[0]?.[0];
  const text = componentText(payload);
  expect(text).toContain("**Level 91**");
  expect(text).toContain("**Level 100**");
  expect(text).not.toContain("**Level 90**");
  expect(text).toContain("Page 10 of 10");
  expect(text.length).toBeLessThan(4000);
  expect(payload).toMatchObject({ allowedMentions: { parse: [] } });
  expect(f.guild.members.fetch).not.toHaveBeenCalled();
});

test("a full reward list rejects new roles but permits changing an existing milestone", async () => {
  const f = fixture();
  const patch = mock(async () => undefined);
  const reward_roles = Array.from({ length: 100 }, (_, i) => ({
    level: 5,
    role_id: String(BigInt(role5) + BigInt(i)),
  }));
  const context = {
    settings: {
      raw: async () => ({
        enabled: true,
        config: { reward_roles },
        revision: "revision",
      }),
      patch,
    },
  } as unknown as Context;
  const extra = "600000000000000001";
  f.roles.set(extra, { ...f.roles.get(role5), id: extra } as Role);
  await expect(
    execute(
      context,
      commandInteraction(f.guild, "add", { level: 10, role: extra }).value,
    ),
  ).rejects.toThrow("100 reward roles");
  expect(patch).not.toHaveBeenCalled();
  await execute(
    context,
    commandInteraction(f.guild, "add", { level: 10, role: role5 }).value,
  );
  expect(patch).toHaveBeenCalledTimes(1);
});

test("a simultaneous admin edit cannot be overwritten by a stale reward array", async () => {
  const f = fixture();
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "levels", levelsSchema, { reward_roles: [] });
  const context = {
    settings: {
      raw: async () => {
        const original = await settings.raw(guildId, "levels");
        await settings.patch(guildId, "levels", levelsSchema, {
          reward_roles: [{ level: 15, role_id: role15 }],
        });
        return original;
      },
      patch: settings.patch.bind(settings),
    },
  } as unknown as Context;
  await expect(
    execute(
      context,
      commandInteraction(f.guild, "add", { level: 5, role: role5 }).value,
    ),
  ).rejects.toThrow("Settings changed");
  expect(
    (await settings.get(guildId, "levels", levelsSchema)).reward_roles,
  ).toEqual([{ level: 15, role_id: role15 }]);
});

test("the highest unlocked reward replaces earlier rewards and leaves unrelated roles alone", async () => {
  const f = fixture([role5, unrelated]);
  expect(
    await syncLevelRewards(
      f,
      f.member,
      12,
      levelsSchema.parse({ reward_roles: milestoneRoles }),
    ),
  ).toBe(true);
  expect(f.calls).toEqual([`add:${role10}`, `remove:${role5}`]);
  expect(f.member.roles.cache.has(unrelated)).toBe(true);
  expect(f.guild.members.fetch).toHaveBeenCalledWith({
    user: userId,
    force: true,
  });
});

test("skipped milestones and tied rewards grant only the highest tier", async () => {
  const f = fixture();
  const config = levelsSchema.parse({
    reward_roles: [...milestoneRoles, { level: 15, role_id: unrelated }],
  });
  await syncLevelRewards(f, f.member, 20, config);
  expect(f.calls).toEqual([`add:${role15}`, `add:${unrelated}`]);
});

test("already-held highest rewards still clean up previous tiers without re-adding", async () => {
  const f = fixture([role5, role10]);
  await syncLevelRewards(
    f,
    f.member,
    10,
    levelsSchema.parse({ reward_roles: milestoneRoles }),
  );
  expect(f.calls).toEqual([`remove:${role5}`]);
});

test("a failed reward grant retains previous roles and succeeds on a later retry", async () => {
  const f = fixture([role5]);
  const config = levelsSchema.parse({ reward_roles: milestoneRoles });
  f.add.mockImplementationOnce(async () => {
    throw new Error("Discord unavailable");
  });
  expect(await syncLevelRewards(f, f.member, 10, config)).toBe(false);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.member.roles.cache.has(role5)).toBe(true);
  expect(await syncLevelRewards(f, f.member, 10, config)).toBe(true);
  expect(f.calls).toEqual([`add:${role10}`, `remove:${role5}`]);
});

test("unsafe or deleted new rewards retain previous roles; unsafe old roles are never removed", async () => {
  const config = levelsSchema.parse({ reward_roles: milestoneRoles });
  const missing = fixture([role5]);
  missing.roles.delete(role10);
  expect(await syncLevelRewards(missing, missing.member, 10, config)).toBe(
    false,
  );
  expect(missing.calls).toEqual([]);
  const unsafe = fixture([role5]);
  const oldRole = unsafe.roles.get(role5);
  if (!oldRole) throw new Error("Missing fixture role");
  Object.assign(oldRole, {
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
  });
  expect(await syncLevelRewards(unsafe, unsafe.member, 10, config)).toBe(false);
  expect(unsafe.remove).not.toHaveBeenCalled();
  expect(unsafe.member.roles.cache.has(role5)).toBe(true);
});

test("dropping below the first milestone removes only configured reward roles", async () => {
  const f = fixture([role5, role10, unrelated]);
  await syncLevelRewards(
    f,
    f.member,
    0,
    levelsSchema.parse({ reward_roles: milestoneRoles }),
  );
  expect(f.calls).toEqual([`remove:${role5}`, `remove:${role10}`]);
  expect(f.member.roles.cache.has(unrelated)).toBe(true);
});

test("an XP award and an admin reset for one member cannot race role replacements", async () => {
  const f = fixture([role5, unrelated]);
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "levels", levelsSchema, {
    enabled: true,
    reward_channel_id: null,
    reward_roles: milestoneRoles,
    xp_gain: { min: 15, max: 15 },
  });
  const repository = new LevelsRepository(db, botId);
  await repository.set(guildId, userId, 164999); // One XP below level 10.
  let release!: () => void;
  let notifyStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.add.mockImplementationOnce(async (role) => {
    notifyStarted();
    await pending;
    f.calls.push(`add:${role.id}`);
    f.member.roles.cache.set(role.id, role);
  });
  let onMessage:
    | ((...args: ClientEvents[typeof Events.MessageCreate]) => Promise<void>)
    | undefined;
  const registrar: EventRegistrar = {
    on(event, handler) {
      if (event === Events.MessageCreate)
        onMessage = handler as typeof onMessage;
    },
    every() {},
  };
  const context = { db, botId, settings, log: f.log } as unknown as Context;
  levelsPlugin.register?.(context, registrar);
  if (!onMessage) throw new Error("Missing message handler");
  const award = onMessage({
    inGuild: () => true,
    guildId,
    guild: f.guild,
    member: f.member,
    author: { id: userId, bot: false },
    channelId: "500000000000000001",
    channel: { isThread: () => false },
  } as unknown as ClientEvents[typeof Events.MessageCreate][0]);
  await started;
  const editReply = mock(async (_payload: unknown) => undefined);
  const reset = execute(context, {
    guildId,
    guild: f.guild,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    options: {
      getSubcommandGroup: () => null,
      getSubcommand: () => "reset",
      getUser: () => ({ id: userId }),
    },
    editReply,
  } as unknown as ChatInputCommandInteraction<"cached">);
  try {
    expect((await repository.get(guildId, userId))?.level).toBe(10);
    expect(editReply).not.toHaveBeenCalled();
  } finally {
    release();
  }
  await Promise.all([award, reset]);
  expect((await repository.get(guildId, userId))?.level).toBe(0);
  expect(f.calls).toEqual([
    `add:${role10}`,
    `remove:${role5}`,
    `remove:${role10}`,
  ]);
  expect([...f.member.roles.cache.keys()]).toEqual([unrelated]);
});

test("newly configured rewards catch up on ordinary XP awards without another level-up or announcement channel", async () => {
  const f = fixture([role5]);
  const catchUpBotId = "100000000000000003";
  const settings = new SettingsStore(db, catchUpBotId);
  await settings.patch(guildId, "levels", levelsSchema, {
    enabled: true,
    reward_channel_id: null,
    reward_roles: milestoneRoles,
    xp_gain: { min: 15, max: 15 },
  });
  const repository = new LevelsRepository(db, catchUpBotId);
  await repository.set(guildId, userId, 165100); // Already level 10.
  let onMessage:
    | ((...args: ClientEvents[typeof Events.MessageCreate]) => Promise<void>)
    | undefined;
  levelsPlugin.register?.(
    { db, botId: catchUpBotId, settings, log: f.log } as unknown as Context,
    {
      on(event, handler) {
        if (event === Events.MessageCreate)
          onMessage = handler as typeof onMessage;
      },
      every() {},
    },
  );
  if (!onMessage) throw new Error("Missing message handler");
  await onMessage({
    inGuild: () => true,
    guildId,
    guild: f.guild,
    member: f.member,
    author: { id: userId, bot: false },
    channelId: "500000000000000001",
    channel: { isThread: () => false },
  } as unknown as ClientEvents[typeof Events.MessageCreate][0]);
  expect((await repository.get(guildId, userId))?.level).toBe(10);
  expect(f.calls).toEqual([`add:${role10}`, `remove:${role5}`]);
  expect(f.warn).not.toHaveBeenCalled();
});

test("level zero is accepted in saved settings and the deployed add/remove commands", async () => {
  const rewards = levelsPlugin.commands?.[0]?.data
    .toJSON()
    .options?.find((option) => option.name === "rewards");
  if (rewards?.type !== ApplicationCommandOptionType.SubcommandGroup)
    throw new Error("Missing reward group");
  for (const name of ["add", "remove"]) {
    const levelOption = rewards.options
      ?.find((option) => option.name === name)
      ?.options?.find((option) => option.name === "level");
    expect(levelOption).toMatchObject({ min_value: 0 });
  }
  expect(
    levelsSchema.safeParse({ reward_roles: [{ level: -1, role_id: role5 }] })
      .success,
  ).toBe(false);
  const f = fixture();
  const settings = new SettingsStore(db, "100000000000000004");
  const context = { settings } as unknown as Context;
  const added = commandInteraction(f.guild, "add", { level: 0, role: role5 });
  await execute(context, added.value);
  expect(
    (await settings.get(guildId, "levels", levelsSchema)).reward_roles,
  ).toEqual([{ level: 0, role_id: role5 }]);
  expect(componentText(added.editReply.mock.calls[0]?.[0])).toContain(
    "on joining",
  );
  await execute(
    context,
    commandInteraction(f.guild, "remove", { level: 0 }).value,
  );
  expect(
    (await settings.get(guildId, "levels", levelsSchema)).reward_roles,
  ).toEqual([]);
});

function joinScenario(
  savedLevel: number | null = null,
  enabled = true,
  isBot = false,
) {
  const f = fixture();
  const config = levelsSchema.parse({
    enabled,
    reward_roles: [
      { level: 0, role_id: role5 },
      { level: 5, role_id: role10 },
      { level: 10, role_id: role15 },
    ],
  });
  const query = mock(async (_sql: string, _parameters?: unknown[]) =>
    savedLevel === null ? [] : [{ user_id: userId, level: savedLevel, xp: 20 }],
  );
  const get = mock(async () => config);
  let onJoin: ((member: GuildMember) => Promise<void>) | undefined;
  levelsPlugin.register?.(
    {
      botId,
      db: { query },
      settings: { get },
      log: f.log,
    } as unknown as Context,
    {
      on(event, handler) {
        if (event === Events.GuildMemberAdd) onJoin = handler as typeof onJoin;
      },
      every() {},
    },
  );
  if (!onJoin) throw new Error("Missing join handler");
  const handler = onJoin;
  const member = {
    ...f.member,
    user: { id: userId, bot: isBot },
  } as unknown as GuildMember;
  return { ...f, config, query, get, emit: () => handler(member) };
}

test("a new member receives the level-zero role immediately without awarding XP or posting a level-up", async () => {
  const f = joinScenario();
  await f.emit();
  expect(f.calls).toEqual([`add:${role5}`]);
  expect(f.query).toHaveBeenCalledTimes(1);
  const call = f.query.mock.calls[0];
  expect(call?.[0].startsWith("select")).toBe(true);
  expect(call?.[1]).toEqual([botId, guildId, userId]);
});

test("a returning member regains the highest earned milestone instead of the level-zero role", async () => {
  const f = joinScenario(7);
  await f.emit();
  expect(f.calls).toEqual([`add:${role10}`]);
});

test("bots and servers with levels disabled never receive join rewards", async () => {
  const bot = joinScenario(null, true, true);
  await bot.emit();
  expect(bot.get).not.toHaveBeenCalled();
  const disabled = joinScenario(null, false);
  await disabled.emit();
  expect(disabled.query).not.toHaveBeenCalled();
  expect(disabled.calls).toEqual([]);
});

test("level-zero rewards persist until the first milestone, then are replaced and restored on reset", async () => {
  const f = joinScenario();
  await f.emit();
  await syncLevelRewards(f, f.member, 4, f.config);
  expect(f.calls).toEqual([`add:${role5}`]);
  await syncLevelRewards(f, f.member, 5, f.config);
  expect(f.calls).toEqual([`add:${role5}`, `add:${role10}`, `remove:${role5}`]);
  await syncLevelRewards(f, f.member, 0, f.config);
  expect(f.calls.slice(-2)).toEqual([`add:${role5}`, `remove:${role10}`]);
});

test("an unsafe level-zero role cannot be assigned on joining", async () => {
  const f = joinScenario();
  const role = f.roles.get(role5);
  if (!role) throw new Error("Missing fixture role");
  Object.assign(role, {
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
  });
  await f.emit();
  expect(f.calls).toEqual([]);
  expect(f.warn).toHaveBeenCalledTimes(1);
});
