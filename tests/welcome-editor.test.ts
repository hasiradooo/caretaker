import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  ApplicationCommandOptionType,
  ChannelType,
  type ChatInputCommandInteraction,
  type ClientEvents,
  ComponentType,
  Events,
  type GuildMember,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context, EventRegistrar } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { welcomePlugin } from "../src/plugins/welcome";
import { welcomeSchema } from "../src/plugins/welcome/config";
import { greetingCard } from "../src/plugins/welcome/presentation";
import { WelcomeSettingsEditor } from "../src/plugins/welcome/settings-editor";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001",
  guildId = "200000000000000001",
  userId = "300000000000000001";
const channelId = "400000000000000001",
  alternateId = "400000000000000002",
  roleId = "500000000000000001";
let db: Database;
beforeAll(async () => {
  db = await testDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
function idFor(payload: unknown, action: string): string {
  const buttons = wire(payload).components.flatMap(
    (item: { components?: { custom_id?: string }[] }) => item.components ?? [],
  );
  const found = buttons.find((item: { custom_id?: string }) =>
    item.custom_id?.endsWith(`:${action}`),
  );
  if (!found) throw new Error(`Missing control ${action}`);
  return found.custom_id;
}

async function fixture() {
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "welcome_goodbye", welcomeSchema, {
    enabled: false,
    welcome_channel_id: channelId,
    leave_channel_id: null,
    welcome_message:
      "Hello {user}, read <#400000000000000001>. {display_name} joined {server}, member {member_count}.",
    goodbye_message: "Bye {display_name}. {member_count} remain.",
    join_role_ids: [roleId],
    include_bots: false,
    custom_note: "Keep this",
  });
  const send = mock(async (_value: unknown) => undefined);
  const channel = {
    id: channelId,
    type: ChannelType.GuildText,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () =>
      new PermissionsBitField([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
      ]),
    send,
  };
  const guild = {
    id: guildId,
    name: "Kiro's backrooms",
    memberCount: 42,
    channels: {
      fetch: mock(async (id: string) =>
        [channelId, alternateId].includes(id) ? { ...channel, id } : null,
      ),
    },
    members: { me: {} },
  };
  const member = {
    id: userId,
    nickname: "Wanderer",
    user: { id: userId, displayName: "Account name", bot: false },
    guild,
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
  };
  let clock = 0;
  const editor = new WelcomeSettingsEditor(() => clock);
  const context = {
    settings,
    botId,
    log: { warn: mock(() => undefined), error: mock(() => undefined) },
  } as unknown as Context;
  let payload: unknown;
  const base = {
    guildId,
    guild,
    user: member.user,
    member,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    editReply: mock(async (value: unknown) => {
      payload = value;
    }),
  };
  const open = async () =>
    editor.open(
      context,
      base as unknown as ChatInputCommandInteraction<"cached">,
    );
  await open();
  const interaction = (
    id: string,
    kind = "button",
    values: string[] = [],
    overrides = {},
  ) => ({
    ...base,
    customId: id,
    values,
    message: { author: { id: botId } },
    isMessageComponent: () => kind !== "modal",
    isModalSubmit: () => kind === "modal",
    isButton: () => kind === "button",
    isStringSelectMenu: () => kind === "string",
    isChannelSelectMenu: () => kind === "channel",
    isFromMessage: () => true,
    fields: { getTextInputValue: () => values[0] ?? "" },
    deferUpdate: mock(async () => undefined),
    showModal: mock(async (_value: unknown) => undefined),
    ...overrides,
  });
  const handle = async (event: ReturnType<typeof interaction>) =>
    editor.handle(context, event as unknown as Interaction<"cached">);
  const act = async (
    action: string,
    kind = "button",
    values: string[] = [],
  ) => {
    const event = interaction(idFor(payload, action), kind, values);
    await handle(event);
    return event;
  };
  return {
    settings,
    context,
    base,
    editor,
    open,
    interaction,
    handle,
    act,
    send,
    channel,
    member,
    payload: () => payload,
    expire: () => {
      clock += 900000;
    },
    saved: () => settings.get(guildId, "welcome_goodbye", welcomeSchema),
  };
}

test("/welcome settings opens a private V2 editor and set keeps the goodbye controls available", async () => {
  const f = await fixture();
  const command = welcomePlugin.commands?.[0];
  if (!command) throw new Error("Missing welcome command");
  for (const item of welcomePlugin.commands ?? []) {
    const options = item.data.toJSON().options ?? [];
    expect(options.map((option) => option.name)).toEqual([
      "settings",
      "set",
      "channel",
      "message",
      "preview",
    ]);
    expect(
      options.every(
        (option) => option.type === ApplicationCommandOptionType.Subcommand,
      ),
    ).toBe(true);
    expect(item.data.toJSON().default_member_permissions).toBe(
      String(PermissionFlagsBits.ManageGuild),
    );
  }
  const deferReply = mock(async (_payload: unknown) => undefined);
  await new PluginRuntime(f.context, [welcomePlugin]).dispatch({
    ...f.base,
    commandName: "welcome",
    isRepliable: () => true,
    inCachedGuild: () => true,
    isChatInputCommand: () => true,
    deferReply,
    options: { getSubcommand: () => "settings" },
  } as unknown as ChatInputCommandInteraction);
  expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  const payload = wire(f.payload());
  expect(payload.flags).toBe(MessageFlags.IsComponentsV2);
  expect(payload).not.toHaveProperty("embeds");
  expect(
    payload.components.some(
      (item: { type: number }) => item.type === ComponentType.Container,
    ),
  ).toBe(false);
  expect(payload.allowedMentions.parse).toEqual([]);
  expect(componentText(payload)).toContain("Welcome editor");
  await command.execute(f.context, {
    ...f.base,
    options: {
      getSubcommand: () => "set",
      getChannel: () => ({ id: alternateId }),
      getString: () => "New welcome",
    },
  } as unknown as ChatInputCommandInteraction<"cached">);
  expect(await f.saved()).toMatchObject({
    enabled: true,
    welcome_channel_id: alternateId,
    welcome_message: "New welcome",
    goodbye_message: "Bye {display_name}. {member_count} remain.",
  });
  // Supplying quick-setup arguments must still expose the goodbye editor.
  expect(idFor(f.payload(), "goodbye")).toBeString();
  expect(componentText(f.payload())).toContain("Welcome editor");
});

test("/goodbye settings opens the goodbye controls directly and remains private and admin-only", async () => {
  const f = await fixture();
  const command = welcomePlugin.commands?.find(
    (item) => item.data.toJSON().name === "goodbye",
  );
  if (!command) throw new Error("Missing goodbye command");
  expect(command.data.toJSON().default_member_permissions).toBe(
    String(PermissionFlagsBits.ManageGuild),
  );
  const before = await f.settings.raw(guildId, "welcome_goodbye");
  const deferReply = mock(async (_payload: unknown) => undefined);
  await new PluginRuntime(f.context, [welcomePlugin]).dispatch({
    ...f.base,
    commandName: "goodbye",
    isRepliable: () => true,
    inCachedGuild: () => true,
    isChatInputCommand: () => true,
    deferReply,
    options: { getSubcommand: () => "settings" },
  } as unknown as ChatInputCommandInteraction);
  expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  expect(componentText(f.payload())).toContain("Goodbye editor");
  const rows = wire(f.payload()).components.filter(
    (item: { type: number }) => item.type === ComponentType.ActionRow,
  );
  expect(
    rows[0].components.map((button: { label: string }) => button.label),
  ).toEqual(["Welcome", "Goodbye"]);
  expect(rows[1].components[0].label).toBe("Edit goodbye text");
  expect(
    rows
      .flatMap((row: { components: { type: number }[] }) => row.components)
      .every(
        (control: { type: number }) => control.type === ComponentType.Button,
      ),
  ).toBe(true);
  expect(await f.settings.raw(guildId, "welcome_goodbye")).toEqual(before);
  await expect(
    command.execute(f.context, {
      ...f.base,
      memberPermissions: new PermissionsBitField(),
    } as unknown as ChatInputCommandInteraction<"cached">),
  ).rejects.toThrow("Manage Server");
});

for (const kind of ["welcome", "goodbye"] as const) {
  test(`/${kind} shortcuts save only their own fields and preview without posting`, async () => {
    const f = await fixture();
    const command = welcomePlugin.commands?.find(
      (item) => item.data.toJSON().name === kind,
    );
    if (!command) throw new Error("Missing greeting command");
    const channelKey =
      kind === "welcome" ? "welcome_channel_id" : "leave_channel_id";
    const messageKey =
      kind === "welcome" ? "welcome_message" : "goodbye_message";
    const original = await f.saved();
    const execute = (
      action: string,
      channel: string | null = null,
      message: string | null = null,
    ) =>
      command.execute(f.context, {
        ...f.base,
        options: {
          getSubcommand: () => action,
          getChannel: () => (channel ? { id: channel } : null),
          getString: () => message,
        },
      } as unknown as ChatInputCommandInteraction<"cached">);

    await execute("channel", alternateId);
    expect(await f.saved()).toEqual({ ...original, [channelKey]: alternateId });
    await execute("message", null, "  New {display_name} message  ");
    expect(await f.saved()).toEqual({
      ...original,
      [channelKey]: alternateId,
      [messageKey]: "New {display_name} message",
    });

    const beforePreview = await f.settings.raw(guildId, "welcome_goodbye");
    const deferReply = mock(async (_payload: unknown) => undefined);
    await new PluginRuntime(f.context, [welcomePlugin]).dispatch({
      ...f.base,
      commandName: kind,
      isRepliable: () => true,
      inCachedGuild: () => true,
      isChatInputCommand: () => true,
      deferReply,
      options: { getSubcommand: () => "preview" },
    } as unknown as ChatInputCommandInteraction);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(componentText(f.payload())).toContain("Private preview");
    expect(componentText(f.payload())).toContain("New Wanderer message");
    expect(idFor(f.payload(), "back")).toBeString();
    expect(wire(f.payload()).allowedMentions.parse).toEqual([]);
    expect(await f.settings.raw(guildId, "welcome_goodbye")).toEqual(
      beforePreview,
    );
    expect(f.send).not.toHaveBeenCalled();

    await execute("set", channelId);
    expect(await f.saved()).toEqual({
      ...original,
      enabled: true,
      [channelKey]: channelId,
      [messageKey]: "New {display_name} message",
    });
    await execute("set", alternateId, "Setup template");
    expect(await f.saved()).toEqual({
      ...original,
      enabled: true,
      [channelKey]: alternateId,
      [messageKey]: "Setup template",
    });
  });

  test(`/${kind} rejects invalid or unauthorized shortcuts without changing saved settings`, async () => {
    const f = await fixture();
    const command = welcomePlugin.commands?.find(
      (item) => item.data.toJSON().name === kind,
    );
    if (!command) throw new Error("Missing greeting command");
    const before = await f.settings.raw(guildId, "welcome_goodbye");
    for (const action of ["settings", "set", "channel", "message", "preview"]) {
      await expect(
        command.execute(f.context, {
          ...f.base,
          memberPermissions: new PermissionsBitField(),
          options: { getSubcommand: () => action },
        } as unknown as ChatInputCommandInteraction<"cached">),
      ).rejects.toThrow("Manage Server");
    }
    await expect(
      command.execute(f.context, {
        ...f.base,
        options: {
          getSubcommand: () => "message",
          getChannel: () => null,
          getString: () => "   ",
        },
      } as unknown as ChatInputCommandInteraction<"cached">),
    ).rejects.toThrow("cannot be blank");
    f.channel.permissionsFor = () => new PermissionsBitField();
    await expect(
      command.execute(f.context, {
        ...f.base,
        options: {
          getSubcommand: () => "set",
          getChannel: () => ({ id: alternateId }),
          getString: () => "Must not save",
        },
      } as unknown as ChatInputCommandInteraction<"cached">),
    ).rejects.toThrow("cannot view or send");
    expect(await f.settings.raw(guildId, "welcome_goodbye")).toEqual(before);
  });
}

test("cached flat welcome commands still work while Discord refreshes its menu", async () => {
  const f = await fixture();
  const command = welcomePlugin.commands?.[0];
  if (!command) throw new Error("Missing welcome command");
  await command.execute(f.context, {
    ...f.base,
    options: {
      getSubcommand: () => null,
      getChannel: () => ({ id: alternateId }),
      getString: () => "Cached menu",
    },
  } as unknown as ChatInputCommandInteraction<"cached">);
  expect(await f.saved()).toMatchObject({
    enabled: true,
    welcome_channel_id: alternateId,
    welcome_message: "Cached menu",
  });
});

test("goodbye button opens its own prefilled input and lets an admin revise a draft without losing text", async () => {
  const f = await fixture();
  const before = await f.settings.raw(guildId, "welcome_goodbye");
  await f.act("goodbye");
  const shown = await f.act("message");
  const modal = wire(shown.showModal.mock.calls[0]?.[0]);
  expect(modal.title).toBe("Edit goodbye message");
  expect(modal.components[0].component.value).toBe(
    "Bye {display_name}. {member_count} remain.",
  );
  await f.handle(
    f.interaction(modal.custom_id, "modal", ["Goodbye draft one"]),
  );
  const revised = await f.act("message");
  const revisedModal = wire(revised.showModal.mock.calls[0]?.[0]);
  expect(revisedModal.components[0].component.value).toBe("Goodbye draft one");
  expect(await f.settings.raw(guildId, "welcome_goodbye")).toEqual(before);
  await f.handle(
    f.interaction(revisedModal.custom_id, "modal", ["Goodbye draft two"]),
  );
  await f.act("apply");
  expect((await f.saved()).goodbye_message).toBe("Goodbye draft two");
  expect((await f.saved()).welcome_message).toBe(
    before.config.welcome_message as string,
  );
  await f.act("welcome");
  expect(componentText(f.payload())).toContain("Welcome editor");
});

test("long messages keep the editor compact but the input retains the full saved text", async () => {
  const f = await fixture();
  const text = "Message ".repeat(220);
  await f.settings.patch(guildId, "welcome_goodbye", welcomeSchema, {
    welcome_message: text,
  });
  await f.open();
  expect(componentText(f.payload()).length).toBeLessThan(1300);
  expect(idFor(f.payload(), "goodbye")).toBeString();
  const shown = await f.act("message");
  const modal = wire(shown.showModal.mock.calls[0]?.[0]);
  expect(modal.components[0].component.value).toBe(text);
});

test("editing goodbye text and channel preserves the welcome, join roles, and legacy settings", async () => {
  const f = await fixture();
  await f.act("goodbye");
  const shown = await f.act("message");
  expect(shown.deferUpdate).not.toHaveBeenCalled();
  const modal = wire(shown.showModal.mock.calls[0]?.[0]);
  expect(modal.components[0].type).toBe(ComponentType.Label);
  await f.handle(
    f.interaction(modal.custom_id, "modal", [
      "**{display_name}** found the exit. <#400000000000000001>",
    ]),
  );
  expect((await f.saved()).goodbye_message).toBe(
    "Bye {display_name}. {member_count} remain.",
  );
  expect(wire(f.payload()).allowedMentions.parse).toEqual([]);
  await f.act("apply");
  await f.act("channel");
  await f.act("destination", "channel", [alternateId]);
  expect(await f.saved()).toMatchObject({
    enabled: false,
    welcome_channel_id: channelId,
    leave_channel_id: alternateId,
    goodbye_message: "**{display_name}** found the exit. <#400000000000000001>",
    join_role_ids: [roleId],
    include_bots: false,
    custom_note: "Keep this",
  });
  expect((await f.saved()).welcome_message).toStartWith("Hello {user}");
  await f.act("clear");
  expect((await f.saved()).leave_channel_id).toBeNull();
  expect((await f.saved()).goodbye_message).toStartWith("**{display_name}**");
  await f.act("back");
  await f.act("toggle");
  expect((await f.saved()).enabled).toBe(true);
});

test("previews use the event renderer, never notify, and do not change settings or send to a channel", async () => {
  const f = await fixture();
  const before = await f.settings.raw(guildId, "welcome_goodbye");
  for (const kind of ["welcome", "goodbye"] as const) {
    await f.act(kind);
    await f.act("preview");
    const preview = wire(f.payload());
    expect(preview.allowedMentions).toEqual({ parse: [], repliedUser: false });
    expect(componentText(preview)).toContain("Private preview");
    expect(componentText(preview)).toContain("Wanderer");
    expect(componentText(preview)).toContain("42");
    const actual = componentText(
      greetingCard(await f.saved(), kind, f.member as unknown as GuildMember),
    );
    expect(componentText(preview).split("\n-#")[0]).toBe(
      actual.split("\n-#")[0],
    );
    await f.act("back");
  }
  expect(await f.settings.raw(guildId, "welcome_goodbye")).toEqual(before);
  const draft = await f.act("message");
  await f.handle(
    f.interaction(wire(draft.showModal.mock.calls[0]?.[0]).custom_id, "modal", [
      "Discard this draft",
    ]),
  );
  expect(componentText(f.payload())).toContain("Discard this draft");
  await f.act("back");
  expect(await f.settings.raw(guildId, "welcome_goodbye")).toEqual(before);
  expect(f.send).not.toHaveBeenCalled();
});

test("cancelled modals keep the editor usable and stale saves preserve other admin changes", async () => {
  const f = await fixture();
  const first = await f.act("message");
  const second = await f.act("message");
  const submit = f.interaction(
    wire(second.showModal.mock.calls[0]?.[0]).custom_id,
    "modal",
    ["Saved welcome"],
  );
  await f.handle(submit);
  expect((await f.saved()).welcome_message).toStartWith("Hello {user}");
  await f.act("apply");
  await expect(f.handle(submit)).rejects.toThrow("outdated");
  await f.handle(
    f.interaction(wire(first.showModal.mock.calls[0]?.[0]).custom_id, "modal", [
      "Stale welcome",
    ]),
  );
  await f.act("apply");
  expect((await f.saved()).welcome_message).toBe("Saved welcome");
  expect(componentText(f.payload())).toContain("Settings changed");
  await f.act("preview");
  expect(componentText(f.payload())).toContain("Saved welcome");
  expect(componentText(f.payload())).not.toContain("Stale welcome");
  await f.act("back");
  await f.settings.patch(guildId, "welcome_goodbye", welcomeSchema, {
    goodbye_message: "Someone else's edit",
  });
  await f.act("toggle");
  expect((await f.saved()).enabled).toBe(false);
  expect((await f.saved()).goodbye_message).toBe("Someone else's edit");
});

test("blank/oversized text and inaccessible channels produce a usable editor without saving", async () => {
  const f = await fixture();
  for (const input of ["  ", "x".repeat(1801)]) {
    const shown = await f.act("message");
    await f.handle(
      f.interaction(
        wire(shown.showModal.mock.calls[0]?.[0]).custom_id,
        "modal",
        [input],
      ),
    );
    expect(componentText(f.payload())).toContain("1,800");
  }
  f.channel.permissionsFor = () => new PermissionsBitField();
  await f.act("channel");
  await f.act("destination", "channel", [alternateId]);
  expect(componentText(f.payload())).toContain("cannot view or send");
  expect((await f.saved()).welcome_channel_id).toBe(channelId);
  expect((await f.saved()).welcome_message).toStartWith("Hello {user}");
});

test("editor rejects another admin, guild, bot, revoked permissions and expired controls", async () => {
  const f = await fixture();
  const id = idFor(f.payload(), "toggle");
  for (const overrides of [
    { user: { id: "stranger" } },
    { guildId: "other" },
    { message: { author: { id: "other" } } },
    { memberPermissions: new PermissionsBitField() },
  ]) {
    const event = f.interaction(id, "button", [], overrides);
    await expect(f.handle(event)).rejects.toThrow();
    expect(event.deferUpdate).not.toHaveBeenCalled();
  }
  await expect(
    f.editor.handle(
      { ...f.context, botId: "other" },
      f.interaction(id) as unknown as Interaction<"cached">,
    ),
  ).rejects.toThrow();
  f.expire();
  await expect(f.handle(f.interaction(id))).rejects.toThrow("expired");
  expect((await f.saved()).enabled).toBe(false);
});

test("real join and leave events use separate destinations and only welcome can mention the subject", async () => {
  const f = await fixture();
  await f.settings.patch(guildId, "welcome_goodbye", welcomeSchema, {
    enabled: true,
    join_role_ids: [],
    leave_channel_id: alternateId,
    welcome_message: "Hello {user}! @everyone <@&500000000000000001>",
    goodbye_message: "Bye {display_name} <@300000000000000099> @everyone",
  });
  const handlers = new Map<
    keyof ClientEvents,
    (...args: unknown[]) => Promise<void>
  >();
  welcomePlugin.register?.(f.context, {
    on: (event, handler) => {
      handlers.set(event, handler as never);
    },
    every: () => {},
  } as EventRegistrar);
  await handlers.get(Events.GuildMemberAdd)?.(f.member);
  await handlers.get(Events.GuildMemberRemove)?.(f.member);
  expect(f.member.guild.channels.fetch.mock.calls.map(([id]) => id)).toEqual([
    channelId,
    alternateId,
  ]);
  expect(wire(f.send.mock.calls[0]?.[0]).allowedMentions).toEqual({
    parse: [],
    repliedUser: false,
    users: [userId],
  });
  expect(wire(f.send.mock.calls[1]?.[0]).allowedMentions).toEqual({
    parse: [],
    repliedUser: false,
  });
  f.member.user.bot = true;
  await handlers.get(Events.GuildMemberAdd)?.(f.member);
  await handlers.get(Events.GuildMemberRemove)?.(f.member);
  expect(f.send).toHaveBeenCalledTimes(2);
  f.member.user.bot = false;
  await f.settings.patch(guildId, "welcome_goodbye", welcomeSchema, {
    enabled: false,
  });
  await handlers.get(Events.GuildMemberAdd)?.(f.member);
  expect(f.send).toHaveBeenCalledTimes(2);
});

test("names cannot inject Markdown, mentions or placeholders, and departed partial members have a fallback", async () => {
  const f = await fixture();
  f.member.nickname = "**@everyone** <@123> {server}";
  const text = componentText(
    greetingCard(
      await f.saved(),
      "goodbye",
      f.member as unknown as GuildMember,
    ),
  );
  expect(text).not.toContain("**@everyone**");
  expect(text).not.toContain("<@123>");
  expect(text).toContain("{server}");
  const partial = { ...f.member, nickname: null, user: null };
  const payload = greetingCard(
    await f.saved(),
    "goodbye",
    partial as unknown as GuildMember,
  );
  expect(componentText(payload)).toContain("A member");
  expect(wire(payload).allowedMentions.parse).toEqual([]);
});
