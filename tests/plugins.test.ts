import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  ChannelType,
  type ClientEvents,
  Collection,
  Events,
  type Message,
  type MessageReaction,
} from "discord.js";
import type { Context, EventRegistrar, Plugin } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { createStarboardPlugin } from "../src/plugins/starboard";
import { starboardSchema } from "../src/plugins/starboard/config";
import { componentText } from "../src/shared/messages";

let db: Database;
const botId = "100000000000000001",
  guildId = "200000000000000001";
beforeAll(async () => {
  db = await (await import("./helpers/database")).testDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});

function captureEvents() {
  const handlers: Partial<{
    [K in keyof ClientEvents]: (...args: ClientEvents[K]) => Promise<void>;
  }> = {};
  const registrar: EventRegistrar = {
    on(event, handler) {
      Object.assign(handlers, { [event]: handler });
    },
    every() {},
  };
  return { handlers, registrar };
}

test("removing all reactions deletes the recorded destination after configuration changes", async () => {
  const settings = new SettingsStore(db, botId);
  const oldChannel = "400000000000000001",
    newChannel = "400000000000000002";
  await settings.patch(guildId, "starboard", starboardSchema, {
    enabled: true,
    channel_id: newChannel,
  });
  await db.query(
    "insert into discord.starboards(bot_id,guild_id,source_message_id,source_channel_id,starboard_message_id,starboard_channel_id) values ($1,$2,'source','source-channel','highlight',$3)",
    [botId, guildId, oldChannel],
  );
  const removeMessage = mock(async () => undefined);
  const fetch = mock(async (id: string) => {
    expect(id).toBe(oldChannel);
    return { isTextBased: () => true, messages: { delete: removeMessage } };
  });
  const guild = { id: guildId, channels: { fetch } };
  const { handlers, registrar } = captureEvents();
  const plugin = createStarboardPlugin();
  plugin.register?.({ botId, db, settings } as unknown as Context, registrar);
  await handlers[Events.MessageReactionRemoveAll]?.(
    { id: "source", guild } as unknown as Message<true>,
    new Collection(),
  );
  expect(removeMessage).toHaveBeenCalledWith("highlight");
  expect(
    await db.query(
      "select * from discord.starboards where source_message_id='source'",
    ),
  ).toHaveLength(0);
  await plugin.stop?.({} as Context);
});

test("a public thread inside an adult channel is not copied to a non-adult destination", async () => {
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "starboard", starboardSchema, {
    enabled: true,
    channel_id: "400000000000000002",
    threshold: 1,
  });
  const send = mock(async () => undefined);
  const target = {
    id: "400000000000000002",
    nsfw: false,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    send,
  };
  const guild = {
    id: guildId,
    roles: { everyone: {} },
    members: { me: {} },
    channels: { fetch: async () => target },
  };
  const reaction = {
    partial: false,
    emoji: { id: null, name: "⭐", toString: () => "⭐" },
    count: 3,
    message: {
      id: "other-source",
      guildId,
      guild,
      channelId: "400000000000000003",
      inGuild: () => true,
      author: { id: "300000000000000001", bot: false },
      channel: {
        type: ChannelType.PublicThread,
        isThread: () => true,
        parent: { nsfw: true },
        permissionsFor: () => ({ has: () => true }),
      },
    },
  };
  const { handlers, registrar } = captureEvents();
  const plugin = createStarboardPlugin();
  plugin.register?.({ botId, db, settings } as unknown as Context, registrar);
  await handlers[Events.MessageReactionAdd]?.(
    reaction as unknown as MessageReaction,
    {} as ClientEvents[typeof Events.MessageReactionAdd][1],
    {} as ClientEvents[typeof Events.MessageReactionAdd][2],
  );
  expect(send).not.toHaveBeenCalled();
  await plugin.stop?.({} as Context);
});

test("one failing plugin cleanup does not prevent the remaining cleanup", async () => {
  const stopped = mock(async () => undefined),
    warn = mock(() => undefined);
  const plugin = createStarboardPlugin();
  const plugins: Plugin[] = [
    { ...plugin, id: "first", commands: [], stop: stopped },
    {
      ...plugin,
      id: "second",
      commands: [],
      stop: async () => {
        throw new Error("cleanup failure");
      },
    },
  ];
  await new PluginRuntime(
    { log: { warn } } as unknown as Context,
    plugins,
  ).stop();
  expect(stopped).toHaveBeenCalledTimes(1);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("starboard upgrades an existing embed in place without duplicating or pinging members", async () => {
  const settings = new SettingsStore(db, botId);
  const channelId = "400000000000000004";
  await settings.patch(guildId, "starboard", starboardSchema, {
    enabled: true,
    channel_id: channelId,
    threshold: 1,
    allow_self_star: true,
  });
  await db.query(
    "insert into discord.starboards(bot_id,guild_id,source_message_id,source_channel_id,starboard_message_id,starboard_channel_id) values ($1,$2,'legacy-source','source-channel','legacy-highlight',$3)",
    [botId, guildId, channelId],
  );
  const edit = mock(async (_id: string, _payload: unknown) => undefined);
  const send = mock(async () => undefined);
  const target = {
    id: channelId,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => ({ has: () => true }),
    messages: { edit },
    send,
  };
  const guild = {
    id: guildId,
    roles: { everyone: {} },
    members: { me: {} },
    channels: { fetch: async () => target },
  };
  const reaction = {
    partial: false,
    emoji: { id: null, name: "⭐", toString: () => "⭐" },
    count: 5,
    message: {
      id: "legacy-source",
      guildId,
      guild,
      channelId: "400000000000000005",
      inGuild: () => true,
      content: "A favourite @everyone",
      url: `https://discord.com/channels/${guildId}/400000000000000005/500000000000000001`,
      createdTimestamp: Date.now(),
      attachments: new Collection(),
      author: {
        id: "300000000000000001",
        bot: false,
        displayAvatarURL: () =>
          "https://cdn.discordapp.com/embed/avatars/0.png",
      },
      channel: {
        type: ChannelType.GuildText,
        isThread: () => false,
        permissionsFor: () => ({ has: () => true }),
      },
    },
  };
  const { handlers, registrar } = captureEvents();
  const plugin = createStarboardPlugin();
  plugin.register?.({ botId, db, settings } as unknown as Context, registrar);
  await handlers[Events.MessageReactionAdd]?.(
    reaction as unknown as MessageReaction,
    {} as ClientEvents[typeof Events.MessageReactionAdd][1],
    {} as ClientEvents[typeof Events.MessageReactionAdd][2],
  );
  expect(edit.mock.calls[0]?.[0]).toBe("legacy-highlight");
  const payload = edit.mock.calls[0]?.[1];
  expect(payload).toMatchObject({
    flags: 32768,
    content: null,
    embeds: [],
    allowedMentions: { parse: [] },
  });
  expect(componentText(payload)).toContain("A favourite @everyone");
  expect(send).not.toHaveBeenCalled();
  expect(
    (
      await db.query<{ star_count: number }>(
        "select star_count from discord.starboards where source_message_id='legacy-source'",
      )
    )[0]?.star_count,
  ).toBe(5);
});

for (const scenario of [
  "public",
  "private-thread",
  "private-parent",
  "destination-thread",
] as const) {
  test(`watched parents and renamed custom emoji handle ${scenario} correctly`, async () => {
    const targetId = "400000000000000010";
    const parentId =
      scenario === "destination-thread" ? targetId : "400000000000000011";
    const customEmojiId = "800000000000000001";
    const settings = new SettingsStore(db, botId);
    await settings.patch(guildId, "starboard", starboardSchema, {
      enabled: true,
      channel_id: targetId,
      threshold: 1,
      allow_self_star: true,
      watch_channels: [parentId],
      emoji: `<:old_name:${customEmojiId}>`,
    });
    const send = mock(async (_payload: unknown) => ({
      id: `highlight-${scenario}`,
      delete: mock(async () => {}),
    }));
    const target = {
      id: targetId,
      nsfw: false,
      isSendable: () => true,
      isThread: () => false,
      permissionsFor: () => ({ has: () => true }),
      send,
    };
    const guild = {
      id: guildId,
      roles: { everyone: {} },
      members: { me: {} },
      channels: { fetch: async () => target },
    };
    const reaction = {
      partial: false,
      emoji: {
        id: customEmojiId,
        name: "new_name",
        toString: () => `<:new_name:${customEmojiId}>`,
      },
      count: 3,
      message: {
        id: `thread-${scenario}`,
        guildId,
        guild,
        channelId: "400000000000000012",
        inGuild: () => true,
        content: "A public forum post",
        createdTimestamp: Date.now(),
        attachments: new Collection(),
        url: `https://discord.com/channels/${guildId}/400000000000000012/500000000000000001`,
        author: {
          id: "300000000000000001",
          bot: false,
          displayAvatarURL: () =>
            "https://cdn.discordapp.com/embed/avatars/0.png",
        },
        channel: {
          type:
            scenario === "private-thread"
              ? ChannelType.PrivateThread
              : ChannelType.PublicThread,
          parentId,
          parent: { nsfw: false },
          isThread: () => true,
          permissionsFor: () => ({ has: () => scenario !== "private-parent" }),
        },
      },
    };
    const { handlers, registrar } = captureEvents();
    const plugin = createStarboardPlugin();
    plugin.register?.({ botId, db, settings } as unknown as Context, registrar);
    await handlers[Events.MessageReactionAdd]?.(
      reaction as unknown as MessageReaction,
      {} as ClientEvents[typeof Events.MessageReactionAdd][1],
      {} as ClientEvents[typeof Events.MessageReactionAdd][2],
    );
    expect(send).toHaveBeenCalledTimes(scenario === "public" ? 1 : 0);
    if (scenario === "public")
      expect(componentText(send.mock.calls[0]?.[0])).toContain(
        `<:new_name:${customEmojiId}>`,
      );
    await plugin.stop?.({} as Context);
  });
}
