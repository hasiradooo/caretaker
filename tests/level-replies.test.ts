import { expect, mock, test } from "bun:test";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  type ClientEvents,
  Collection,
  Events,
  type Guild,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
  type User,
} from "discord.js";
import type { Context, EventRegistrar } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import { levelsPlugin } from "../src/plugins/levels";
import { levelsSchema } from "../src/plugins/levels/config";
import {
  levelDisplayName,
  levelProfile,
} from "../src/plugins/levels/presentation";
import { componentText } from "../src/shared/messages";

const userId = "300000000000000001";
const user = {
  id: userId,
  displayName: "Global name",
  displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
};
const member = {
  id: userId,
  user,
  displayName: "Server nickname",
  displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/1.png",
};
const guild = {
  id: "guild",
  members: {
    cache: new Collection([[userId, member]]),
    fetch: mock(async () => {
      throw new Error("Unknown member");
    }),
  },
  client: { users: { cache: new Collection([[userId, user]]) } },
};

test("rank and leaderboard defer publicly, while XP management remains private", async () => {
  for (const action of [
    "rank",
    "leaderboard",
    "set",
    "reset",
    "announcements",
  ]) {
    const interaction = {
      commandName: "level",
      inCachedGuild: () => true,
      isRepliable: () => true,
      isChatInputCommand: () => true,
      options: { getSubcommand: () => action },
      deferReply: mock(async (_options: unknown) => undefined),
    };
    await new PluginRuntime({} as Context, [
      {
        ...levelsPlugin,
        commands: levelsPlugin.commands?.map((command) => ({
          ...command,
          execute: async () => {},
        })),
      },
    ]).dispatch(interaction as unknown as ChatInputCommandInteraction);
    expect(interaction.deferReply.mock.calls[0]?.[0]).toEqual(
      ["rank", "leaderboard"].includes(action)
        ? {}
        : { flags: MessageFlags.Ephemeral },
    );
  }
});

test("rank uses the server nickname and avatar without a mention", async () => {
  const editReply = mock(async (_payload: unknown) => undefined);
  await levelsPlugin.commands?.[0]?.execute(
    {
      botId: "bot",
      settings: { get: async () => levelsSchema.parse({ enabled: true }) },
      db: {
        query: async () => [{ user_id: userId, rank: 1, level: 0, xp: 19 }],
      },
    } as unknown as Context,
    {
      guildId: "guild",
      guild,
      user,
      options: {
        getSubcommandGroup: () => null,
        getUser: () => null,
        getSubcommand: () => "rank",
      },
      editReply,
    } as unknown as ChatInputCommandInteraction<"cached">,
  );
  const payload = editReply.mock.calls[0]?.[0];
  expect(componentText(payload)).toContain("**Server nickname**");
  expect(componentText(payload)).not.toContain(`<@${userId}>`);
  expect(JSON.stringify(payload)).toContain(member.displayAvatarURL());
  expect(payload).toMatchObject({
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [], repliedUser: false },
  });
});

test("leaderboard shows names in rank order and survives an unavailable member", async () => {
  const editReply = mock(async (_payload: unknown) => undefined);
  await levelsPlugin.commands?.[0]?.execute(
    {
      botId: "bot",
      settings: { get: async () => levelsSchema.parse({ enabled: true }) },
      db: {
        query: async () => [
          { user_id: userId, rank: 1, level: 1, xp: 10 },
          { user_id: "missing", rank: 2, level: 0, xp: 19 },
        ],
      },
    } as unknown as Context,
    {
      guildId: "guild",
      guild,
      user,
      options: {
        getSubcommandGroup: () => null,
        getUser: () => null,
        getSubcommand: () => "leaderboard",
        getInteger: () => 1,
      },
      editReply,
    } as unknown as ChatInputCommandInteraction<"cached">,
  );
  const text = componentText(editReply.mock.calls[0]?.[0]);
  expect(text.indexOf("Server nickname")).toBeLessThan(
    text.indexOf("Unknown member"),
  );
  expect(text).not.toContain("<@");
});

test("names fall back to global display names and cannot become Markdown or mention tokens", async () => {
  const profile = await levelProfile(
    guild as unknown as Guild,
    "missing",
    user as unknown as User,
  );
  expect(profile.name).toBe("Global name");
  expect(profile.avatar).toBe(user.displayAvatarURL());
  const name = levelDisplayName("**Name** @everyone <@123>\nNext");
  expect(name).toContain("\\*\\*Name\\*\\*");
  expect(name).not.toContain("@everyone");
  expect(name).not.toContain("<@123>");
  expect(name).not.toContain("\n");
});

function levelUpScenario(rewardChannelId: string | null, canSend = true) {
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
  const send = mock(async (_payload: unknown) => undefined);
  const fetch = mock(async (_channelId: string) => ({
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => canSend }),
    send,
  }));
  const levelGuild = {
    ...guild,
    members: { ...guild.members, me: {} },
    channels: { fetch },
  };
  const db = {
    query: mock(async (sql: string) =>
      sql.startsWith("select")
        ? [{ user_id: userId, level: 0, xp: 2999, last_xp_at: null }]
        : sql.startsWith("update")
          ? [{ user_id: userId, level: 1, xp: 14 }]
          : [],
    ),
    transaction: async <T>(operation: (tx: unknown) => Promise<T>) =>
      operation(db),
  };
  levelsPlugin.register?.(
    {
      botId: "bot",
      db,
      settings: {
        get: async () =>
          levelsSchema.parse({
            enabled: true,
            reward_channel_id: rewardChannelId,
            reward_message:
              "Congrats {user} / {display_name}! @everyone <@300000000000000099>",
            xp_gain: { min: 15, max: 15 },
          }),
      },
    } as unknown as Context,
    registrar,
  );
  const emit = () =>
    onMessage?.({
      inGuild: () => true,
      guildId: "guild",
      guild: levelGuild,
      channelId: "channel",
      author: { ...user, bot: false },
      member: { ...member, roles: { cache: new Collection() } },
      channel: { isThread: () => false },
    } as unknown as ClientEvents[typeof Events.MessageCreate][0]);
  return { emit, send, fetch, query: db.query };
}

test("level-up announcements use the configured channel and notify only the member", async () => {
  const scenario = levelUpScenario("400000000000000001");
  await scenario.emit();
  expect(scenario.fetch).toHaveBeenCalledWith("400000000000000001");
  expect(scenario.fetch).toHaveBeenCalledTimes(1);
  const payload = scenario.send.mock.calls[0]?.[0];
  expect(componentText(payload)).toContain(
    `Congrats <@${userId}> / Server nickname!`,
  );
  expect(payload).toMatchObject({
    allowedMentions: { parse: [], repliedUser: false, users: [userId] },
  });
});

test("without an announcement channel XP is still awarded without posting to chat", async () => {
  const scenario = levelUpScenario(null);
  await scenario.emit();
  expect(
    scenario.query.mock.calls.some(([sql]) => sql.startsWith("update")),
  ).toBe(true);
  expect(scenario.fetch).not.toHaveBeenCalled();
  expect(scenario.send).not.toHaveBeenCalled();
});

test("an inaccessible announcement destination never falls back to the conversation", async () => {
  const scenario = levelUpScenario("400000000000000001", false);
  await expect(scenario.emit()).rejects.toThrow("cannot view or send");
  expect(scenario.fetch).toHaveBeenCalledTimes(1);
  expect(scenario.fetch).toHaveBeenCalledWith("400000000000000001");
  expect(scenario.send).not.toHaveBeenCalled();
});

test("only Manage Server members can choose an announcement channel", async () => {
  const patch = mock(async () => undefined);
  const getChannel = mock(() => ({ id: "400000000000000001" }));
  await expect(
    levelsPlugin.commands?.[0]?.execute(
      { settings: { patch } } as unknown as Context,
      {
        memberPermissions: new PermissionsBitField(),
        options: {
          getSubcommandGroup: () => null,
          getSubcommand: () => "announcements",
          getChannel,
        },
      } as unknown as ChatInputCommandInteraction<"cached">,
    ),
  ).rejects.toThrow("Manage Server");
  expect(patch).not.toHaveBeenCalled();
  expect(getChannel).not.toHaveBeenCalled();
});

test("admins can set a validated destination without enabling levels or replacing settings", async () => {
  const patch = mock(async () => undefined);
  const get = mock(async () => ({ enabled: false }));
  const channelId = "400000000000000001";
  const fetch = mock(async () => ({
    id: channelId,
    type: ChannelType.GuildText,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
  }));
  const editReply = mock(async (_payload: unknown) => undefined);
  await levelsPlugin.commands?.[0]?.execute(
    { settings: { patch, get } } as unknown as Context,
    {
      guildId: "guild",
      guild: { channels: { fetch }, members: { me: {} } },
      memberPermissions: new PermissionsBitField(
        PermissionFlagsBits.ManageGuild,
      ),
      options: {
        getSubcommandGroup: () => null,
        getSubcommand: () => "announcements",
        getChannel: () => ({ id: channelId }),
      },
      editReply,
    } as unknown as ChatInputCommandInteraction<"cached">,
  );
  expect(fetch).toHaveBeenCalledWith(channelId);
  expect(patch).toHaveBeenCalledWith("guild", "levels", levelsSchema, {
    reward_channel_id: channelId,
  });
  expect(get).not.toHaveBeenCalled();
  expect(componentText(editReply.mock.calls[0]?.[0])).toContain(
    `<#${channelId}>`,
  );
});
