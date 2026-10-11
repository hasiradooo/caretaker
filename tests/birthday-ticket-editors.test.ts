import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  ComponentType,
  type Guild,
  type GuildMember,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { birthdayPlugin } from "../src/plugins/birthday";
import { birthdaySchema } from "../src/plugins/birthday/config";
import { birthdayCard } from "../src/plugins/birthday/presentation";
import { BirthdayRepository } from "../src/plugins/birthday/repository";
import { BirthdaySettingsEditor } from "../src/plugins/birthday/settings-editor";
import { createStarboardPlugin } from "../src/plugins/starboard";
import { starboardSchema } from "../src/plugins/starboard/config";
import { StarboardSettingsEditor } from "../src/plugins/starboard/settings-editor";
import {
  matchesStarboardEmoji,
  starboardEmoji,
} from "../src/plugins/starboard/setup";
import { ticketsPlugin } from "../src/plugins/tickets";
import { ticketsSchema } from "../src/plugins/tickets/config";
import { TicketSettingsEditor } from "../src/plugins/tickets/settings-editor";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001",
  guildId = "200000000000000001",
  userId = "300000000000000001";
const channelId = "400000000000000001",
  privateId = "400000000000000002",
  categoryId = "400000000000000003",
  deniedId = "400000000000000004";
const roleId = "500000000000000001",
  otherRole = "500000000000000002";
const watchedIds = Array.from({ length: 101 }, (_, i) =>
  String(700000000000000000n + BigInt(i)),
);
const customEmojiId = "800000000000000001";
let db: Database;
beforeAll(async () => {
  db = await testDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
function controls(payload: unknown) {
  return wire(payload).components.flatMap(
    (item: { components?: { custom_id?: string; disabled?: boolean }[] }) =>
      item.components ?? [],
  );
}
function idFor(payload: unknown, action: string): string {
  const id = controls(payload).find((item: { custom_id?: string }) =>
    item.custom_id?.endsWith(`:${action}`),
  )?.custom_id;
  if (!id) throw new Error(`Missing ${action}`);
  return id;
}
function validLayout(payload: unknown) {
  const json = wire(payload);
  expect(json.flags).toBe(MessageFlags.IsComponentsV2);
  expect(json).not.toHaveProperty("embeds");
  expect(json.allowedMentions.parse).toEqual([]);
  const ids = controls(json)
    .map((item: { custom_id?: string }) => item.custom_id)
    .filter(Boolean);
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    json.components.some(
      (item: { type: number }) => item.type === ComponentType.Container,
    ),
  ).toBe(false);
  expect(
    json.components.filter(
      (item: { type: number }) => item.type === ComponentType.ActionRow,
    ).length,
  ).toBeLessThanOrEqual(3);
  expect(componentText(json).length).toBeLessThanOrEqual(4000);
}

async function fixture(kind: "birthday" | "tickets" | "starboard") {
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "starboard", starboardSchema, {
    enabled: false,
    channel_id: null,
    emoji: "⭐",
    threshold: 15,
    watch_channels: null,
    allow_self_star: false,
    custom_note: "Keep me",
  });
  await settings.patch(guildId, "birthday", birthdaySchema, {
    enabled: false,
    channel_id: null,
    message: "Celebrate {display_name}, {user}, at {server}",
    timezone: "UTC",
    hour: 9,
    custom_note: "Keep me",
  });
  await settings.patch(guildId, "tickets", ticketsSchema, {
    enabled: false,
    category_id: null,
    parent_channel_id: null,
    panel_channel_id: null,
    admin_channel_id: null,
    transcript_channel_id: null,
    panel: {
      title: "Help desk",
      message: "Ask us anything",
      button_label: "Get help",
    },
    mods_role_ids: [],
    auto_close: { enabled: false, threshold_ms: 259200000, reason: "Inactive" },
    role_time_limits: { included: [], excluded: [] },
    custom_note: "Keep me",
  });
  const full = new PermissionsBitField([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ManageChannels,
    PermissionFlagsBits.ManageRoles,
    PermissionFlagsBits.AttachFiles,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const send = mock(async (_payload: unknown) => ({
    url: "https://discord.com/channels/200000000000000001/400000000000000001/600000000000000001",
  }));
  const guild = {
    id: guildId,
    name: "Kiro's server",
    channels: {
      cache: new Map(
        watchedIds.map((id) => [id, { id, name: `public-${id}` }]),
      ),
      fetch: mock(async (id: string) =>
        [channelId, privateId, categoryId, deniedId, ...watchedIds].includes(id)
          ? {
              id,
              type:
                id === categoryId
                  ? ChannelType.GuildCategory
                  : ChannelType.GuildText,
              isSendable: () => id !== categoryId,
              isThread: () => false,
              send,
              permissionsFor: (target: { id?: string }) =>
                id === deniedId || (id === privateId && target.id === guildId)
                  ? new PermissionsBitField()
                  : full,
            }
          : null,
      ),
    },
    members: { me: { id: botId, permissions: full } },
    emojis: {
      fetch: mock(async (id: string) =>
        id === customEmojiId
          ? { id, available: true, toString: () => `<:highlight:${id}>` }
          : null,
      ),
    },
    roles: {
      everyone: { id: guildId },
      fetch: mock(async (id: string) =>
        [roleId, otherRole, guildId].includes(id) ? { id } : null,
      ),
    },
  };
  const member = {
    id: userId,
    displayName: "Wanderer",
    guild,
    displayAvatarURL: () => "https://cdn.discordapp.com/embed/avatars/0.png",
  };
  const context = {
    settings,
    db,
    botId,
    log: { error: mock(() => {}), warn: mock(() => {}) },
  } as unknown as Context;
  let clock = 0;
  const editor =
    kind === "birthday"
      ? new BirthdaySettingsEditor(() => clock)
      : kind === "tickets"
        ? new TicketSettingsEditor(() => clock)
        : new StarboardSettingsEditor(() => clock);
  let payload: unknown;
  const base = {
    guildId,
    guild,
    user: { id: userId },
    member,
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    editReply: mock(async (value: unknown) => {
      payload = value;
    }),
  };
  const open = () =>
    editor.open(
      context,
      base as unknown as ChatInputCommandInteraction<"cached">,
    );
  await open();
  const event = (
    id: string,
    type = "button",
    values: string[] = [],
    fields: Record<string, string> = {},
    overrides = {},
  ) => ({
    ...base,
    customId: id,
    values,
    message: { author: { id: botId } },
    isMessageComponent: () => type !== "modal",
    isModalSubmit: () => type === "modal",
    isFromMessage: () => true,
    isButton: () => type === "button",
    isChannelSelectMenu: () => type === "channel",
    isRoleSelectMenu: () => type === "role",
    isStringSelectMenu: () => type === "string",
    fields: { getTextInputValue: (id: string) => fields[id] ?? "" },
    deferUpdate: mock(async () => {}),
    showModal: mock(async (_value: unknown) => {}),
    ...overrides,
  });
  const handle = (item: ReturnType<typeof event>) =>
    editor.handle(context, item as unknown as Interaction<"cached">);
  const act = async (
    action: string,
    type = "button",
    values: string[] = [],
  ) => {
    const item = event(idFor(payload, action), type, values);
    await handle(item);
    validLayout(payload);
    return item;
  };
  const submit = async (
    shown: ReturnType<typeof event>,
    fields: Record<string, string>,
  ) => {
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    await handle(event(modal.custom_id, "modal", [], fields));
    validLayout(payload);
  };
  return {
    settings,
    context,
    editor,
    base,
    guild,
    member,
    send,
    open,
    handle,
    event,
    act,
    submit,
    payload: () => payload,
    raw: () => settings.raw(guildId, kind),
    birthday: () => settings.get(guildId, "birthday", birthdaySchema),
    tickets: () => settings.get(guildId, "tickets", ticketsSchema),
    starboard: () => settings.get(guildId, "starboard", starboardSchema),
    expire: () => {
      clock += 900000;
    },
  };
}

for (const kind of ["birthday", "tickets", "starboard"] as const) {
  test(`${kind} settings is private, admin-only and usable before enabling`, async () => {
    const f = await fixture(kind);
    const plugin =
      kind === "birthday"
        ? birthdayPlugin
        : kind === "tickets"
          ? ticketsPlugin
          : createStarboardPlugin();
    const command = plugin.commands?.[0];
    if (!command) throw new Error("Command missing");
    const before = await f.raw();
    const deferReply = mock(async (_value: unknown) => {});
    await new PluginRuntime(f.context, [plugin]).dispatch({
      ...f.base,
      commandName: command.data.toJSON().name,
      deferReply,
      isRepliable: () => true,
      inCachedGuild: () => true,
      isChatInputCommand: () => true,
      options: { getSubcommand: () => "settings" },
    } as unknown as ChatInputCommandInteraction);
    expect(deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    validLayout(f.payload());
    expect(await f.raw()).toEqual(before);
    await expect(
      command.execute(f.context, {
        ...f.base,
        options: { getSubcommand: () => "settings" },
        memberPermissions: new PermissionsBitField(),
      } as unknown as ChatInputCommandInteraction<"cached">),
    ).rejects.toThrow("Manage Server");
  });

  test(`${kind} controls reject other admins, bots, guilds, expired sessions and conflicting changes`, async () => {
    const f = await fixture(kind);
    const id = idFor(f.payload(), "toggle");
    for (const overrides of [
      { user: { id: "other" } },
      { guildId: "other" },
      { message: { author: { id: "other" } } },
      { memberPermissions: new PermissionsBitField() },
    ]) {
      const item = f.event(id, "button", [], {}, overrides);
      await expect(f.handle(item)).rejects.toThrow();
      expect(item.deferUpdate).not.toHaveBeenCalled();
    }
    await expect(
      f.editor.handle(
        { ...f.context, botId: "other" },
        f.event(id) as unknown as Interaction<"cached">,
      ),
    ).rejects.toThrow();
    // Make toggling valid so a stale revision is the reason saving fails.
    if (kind === "birthday")
      await f.settings.patch(guildId, kind, birthdaySchema, {
        enabled: true,
        channel_id: channelId,
      });
    else if (kind === "tickets")
      await f.settings.patch(guildId, kind, ticketsSchema, { enabled: true });
    else
      await f.settings.patch(guildId, kind, starboardSchema, {
        enabled: true,
        channel_id: channelId,
      });
    await f.open();
    const stale = idFor(f.payload(), "toggle");
    if (kind === "birthday")
      await f.settings.patch(guildId, kind, birthdaySchema, {
        message: "Other admin",
      });
    else if (kind === "tickets")
      await f.settings.patch(guildId, kind, ticketsSchema, {
        panel: { title: "Other admin" },
      });
    else
      await f.settings.patch(guildId, kind, starboardSchema, { threshold: 8 });
    const changed = await f.raw();
    await f.handle(f.event(stale));
    expect(await f.raw()).toEqual(changed);
    expect(componentText(f.payload())).toContain("Settings changed");
    await expect(f.handle(f.event(stale))).rejects.toThrow("outdated");
    const expired = idFor(f.payload(), "toggle");
    f.expire();
    await expect(f.handle(f.event(expired))).rejects.toThrow("expired");
  });
}

test("birthday editor validates channel and schedule, previews drafts, and preserves saved birthdays", async () => {
  const f = await fixture("birthday");
  const repository = new BirthdayRepository(db, botId);
  await repository.set(guildId, userId, { day: 29, month: 2, year: 2000 });
  await f.act("toggle");
  expect(componentText(f.payload())).toContain("Choose a birthday channel");
  await f.act("channel");
  await f.act("destination", "channel", [deniedId]);
  expect((await f.birthday()).channel_id).toBeNull();
  await f.act("channel");
  await f.act("destination", "channel", [channelId]);
  expect((await f.birthday()).enabled).toBe(false);
  await f.act("home");
  await f.act("message"); // A cancelled modal leaves the original buttons usable.
  const shown = await f.act("message");
  expect(
    wire(shown.showModal.mock.calls[0]?.[0]).components[0].component.value,
  ).toContain("Celebrate");
  await f.submit(shown, {
    message: "Happy birthday **{display_name}** {user} @everyone",
  });
  expect((await f.birthday()).message).toStartWith("Celebrate");
  expect(componentText(f.payload())).toContain("Private preview");
  expect(f.send).not.toHaveBeenCalled();
  await f.act("save");
  expect((await f.birthday()).message).toStartWith("Happy birthday");
  for (const fields of [
    { timezone: "Invalid/Place", hour: "9" },
    { timezone: "Europe/Warsaw", hour: "24" },
    { timezone: "Europe/Warsaw", hour: "1e1" },
  ]) {
    await f.submit(await f.act("schedule"), fields);
    expect((await f.birthday()).timezone).toBe("UTC");
  }
  await f.submit(await f.act("schedule"), {
    timezone: "Europe/Warsaw",
    hour: "10",
  });
  await f.act("toggle");
  expect(await f.birthday()).toMatchObject({
    enabled: true,
    channel_id: channelId,
    timezone: "Europe/Warsaw",
    hour: 10,
    custom_note: "Keep me",
  });
  const announcement = birthdayCard(await f.birthday(), {
    ...f.member,
    displayName: "@everyone **name** {server}",
  } as unknown as GuildMember);
  expect(announcement.allowedMentions).toEqual({
    parse: [],
    repliedUser: false,
    users: [userId],
  });
  expect(componentText(announcement)).toContain("@\u200beveryone");
  expect(componentText(announcement)).not.toContain("2000");
  expect(await repository.get(guildId, userId)).toMatchObject({
    day: 29,
    month: 2,
    year: 2000,
  });
});

test("ticket editor validates destinations and changes role lists without altering other settings", async () => {
  const f = await fixture("tickets");
  const destination = async (field: string, value: string) => {
    await f.act("choose-destination", "string", [field]);
    await f.act("destination", "channel", [value]);
  };
  await destination("transcript_channel_id", channelId);
  expect((await f.tickets()).transcript_channel_id).toBeNull();
  expect(componentText(f.payload())).toContain("private transcript channel");
  await destination("transcript_channel_id", privateId);
  await f.act("channels");
  await destination("parent_channel_id", categoryId);
  expect((await f.tickets()).parent_channel_id).toBeNull();
  await destination("parent_channel_id", channelId);
  await f.act("channels");
  await destination("admin_channel_id", deniedId);
  expect((await f.tickets()).admin_channel_id).toBeNull();
  await destination("admin_channel_id", channelId);
  await f.act("staff");
  await f.act("roles", "role", [roleId, otherRole]);
  expect((await f.tickets()).mods_role_ids).toEqual([roleId, otherRole]);
  await f.act("roles-remove");
  await f.act("roles", "role", [otherRole]);
  expect((await f.tickets()).mods_role_ids).toEqual([roleId]);
  await f.act("roles-add");
  await f.act("roles", "role", [guildId]);
  expect((await f.tickets()).mods_role_ids).toEqual([roleId]);
  expect(await f.tickets()).toMatchObject({
    enabled: false,
    parent_channel_id: channelId,
    transcript_channel_id: privateId,
    admin_channel_id: channelId,
    custom_note: "Keep me",
  });
  expect(f.send).not.toHaveBeenCalled();
});

test("ticket panel edits preview before save and publish only the reviewed saved panel once", async () => {
  const f = await fixture("tickets");
  await f.act("panel");
  expect(
    controls(f.payload()).find(
      (item: { custom_id?: string }) => item.custom_id === "tickets:open",
    )?.disabled,
  ).toBe(true);
  expect(componentText(f.payload())).toContain("Publish to:");
  await f.act("panel-edit"); // Cancelled form must not break the old message.
  await f.submit(await f.act("panel-edit"), {
    title: "Facility support",
    message: "Report your haunted toaster",
    label: "Ask the caretaker",
  });
  expect((await f.tickets()).panel.title).toBe("Help desk");
  expect(componentText(f.payload())).toContain("haunted toaster");
  expect(f.send).not.toHaveBeenCalled();
  await f.act("panel-save");
  expect((await f.tickets()).panel.title).toBe("Facility support");
  await f.act("panel-destination");
  await f.act("destination", "channel", [channelId]);
  await f.act("toggle");
  await f.act("panel");
  const stale = idFor(f.payload(), "publish");
  await f.settings.patch(guildId, "tickets", ticketsSchema, {
    panel: { title: "Revised by another admin" },
  });
  await f.handle(f.event(stale));
  expect(f.send).not.toHaveBeenCalled();
  await f.act("panel");
  const publish = idFor(f.payload(), "publish");
  await f.handle(f.event(publish));
  expect(f.send).toHaveBeenCalledTimes(1);
  const posted = f.send.mock.calls[0]?.[0];
  expect(componentText(posted)).toContain("Revised by another admin");
  expect(componentText(posted)).not.toContain("Private preview");
  expect(
    controls(posted).find(
      (item: { custom_id?: string }) => item.custom_id === "tickets:open",
    )?.disabled,
  ).toBe(false);
  await expect(f.handle(f.event(publish))).rejects.toThrow("outdated");
});

test("ticket inactivity editor preserves nested siblings and edits role exceptions and custom timeouts", async () => {
  const f = await fixture("tickets");
  await f.act("auto");
  await f.submit(await f.act("auto-edit"), {
    minutes: "0",
    reason: "Too fast",
  });
  expect((await f.tickets()).auto_close.threshold_ms).toBe(259200000);
  await f.act("auto");
  await f.submit(await f.act("auto-edit"), {
    minutes: "120",
    warning: "30",
    reason: "No response",
  });
  expect((await f.tickets()).auto_close).toEqual({
    enabled: false,
    threshold_ms: 7200000,
    warning_ms: 1800000,
    reason: "No response",
  });
  await f.act("auto-toggle");
  await f.act("exempt");
  await f.act("roles", "role", [roleId]);
  await f.act("auto");
  await f.act("timeout");
  await f.act("timeout-role", "role", [otherRole]);
  await f.submit(await f.act("timeout-edit"), { seconds: "3600" });
  expect((await f.tickets()).role_time_limits).toEqual({
    included: [{ role_id: otherRole, threshold_seconds: 3600 }],
    excluded: [roleId],
  });
  await f.act("timeout-remove");
  expect((await f.tickets()).role_time_limits).toEqual({
    included: [],
    excluded: [roleId],
  });
  expect((await f.tickets()).auto_close).toEqual({
    enabled: true,
    threshold_ms: 7200000,
    warning_ms: 1800000,
    reason: "No response",
  });
  expect((await f.tickets()).enabled).toBe(false);
});

test("starboard editor validates destinations, previews privately and preserves settings and highlights", async () => {
  const f = await fixture("starboard");
  await db.query(
    "insert into discord.starboards(bot_id,guild_id,source_message_id,source_channel_id,starboard_message_id,starboard_channel_id) values ($1,$2,'editor-source','editor-source-channel','editor-highlight',$3) on conflict do nothing",
    [botId, guildId, channelId],
  );
  await f.act("toggle");
  expect(componentText(f.payload())).toContain("Choose a starboard channel");
  for (const id of [deniedId, categoryId, "400000000000000099"]) {
    await f.act("channel");
    await f.act("destination", "channel", [id]);
    expect((await f.starboard()).channel_id).toBeNull();
  }
  await f.act("channel");
  await f.act("destination", "channel", [channelId]);
  expect((await f.starboard()).enabled).toBe(false);
  await f.act("home");
  await f.act("toggle");
  expect((await f.starboard()).enabled).toBe(true);
  const before = await f.raw();
  await f.act("preview");
  expect(componentText(f.payload())).toContain("Community highlight");
  expect(componentText(f.payload())).toContain("Private preview");
  expect(f.send).not.toHaveBeenCalled();
  expect(await f.raw()).toEqual(before);
  await f.act("home");
  await f.act("self");
  expect((await f.starboard()).allow_self_star).toBe(true);
  await f.act("channel");
  await f.act("clear");
  expect(await f.starboard()).toMatchObject({
    enabled: false,
    channel_id: null,
    custom_note: "Keep me",
    allow_self_star: true,
  });
  expect(
    await db.query(
      "select * from discord.starboards where source_message_id='editor-source'",
    ),
  ).toHaveLength(1);
});

test("starboard inputs reject invalid rules, allow cancellation, and cannot overwrite a newer edit", async () => {
  const f = await fixture("starboard");
  await f.act("threshold"); // Cancel: the original panel remains usable.
  for (const threshold of ["0", "1001", "1.5", "no"]) {
    await f.submit(await f.act("threshold"), { threshold });
    expect((await f.starboard()).threshold).toBe(15);
  }
  await f.submit(await f.act("threshold"), { threshold: "5" });
  expect((await f.starboard()).threshold).toBe(5);
  await f.submit(await f.act("emoji"), { emoji: ":star:" });
  expect((await f.starboard()).emoji).toBe("⭐");
  await f.submit(await f.act("emoji"), { emoji: customEmojiId });
  expect((await f.starboard()).emoji).toBe(`<:highlight:${customEmojiId}>`);
  const stale = await f.act("threshold");
  await f.settings.patch(guildId, "starboard", starboardSchema, {
    threshold: 10,
  });
  await f.submit(stale, { threshold: "8" });
  expect((await f.starboard()).threshold).toBe(10);
  expect(componentText(f.payload())).toContain("Settings changed");
  expect((await f.starboard()).enabled).toBe(false);
  expect((await f.starboard()).custom_note).toBe("Keep me");
});

test("watched channels support all, none, add/remove, and reject private or inaccessible sources", async () => {
  const f = await fixture("starboard");
  await f.settings.patch(guildId, "starboard", starboardSchema, {
    channel_id: channelId,
  });
  await f.act("refresh");
  for (const invalid of [privateId, deniedId, categoryId, channelId]) {
    await f.act("watch");
    await f.act("add-channels", "channel", [invalid]);
    expect((await f.starboard()).watch_channels).toBeNull();
  }
  await f.act("watch");
  await f.act("none");
  expect((await f.starboard()).watch_channels).toEqual([]);
  await f.act("home");
  await f.act("toggle");
  expect((await f.starboard()).enabled).toBe(false);
  expect(componentText(f.payload())).toContain("Choose watched channels");
  await f.act("watch");
  await f.act("add-channels", "channel", [watchedIds[0] as string]);
  await f.act("remove");
  await f.act("remove-channels", "string", [watchedIds[0] as string]);
  expect((await f.starboard()).watch_channels).toEqual([]);
  // Removing the last item returns to an immediately usable channel picker.
  await f.act("add-channels", "channel", [watchedIds[1] as string]);
  expect((await f.starboard()).watch_channels).toEqual([
    watchedIds[1] as string,
  ]);
  await f.act("all");
  expect((await f.starboard()).watch_channels).toBeNull();
  expect((await f.starboard()).enabled).toBe(false);
});

test("100 watched channels remain editable through paging without dropping unselected entries", async () => {
  const f = await fixture("starboard");
  await f.settings.patch(guildId, "starboard", starboardSchema, {
    watch_channels: watchedIds.slice(0, 100),
  });
  await f.act("refresh");
  await f.act("watch");
  await f.act("add-channels", "channel", [watchedIds[100] as string]);
  expect((await f.starboard()).watch_channels).toHaveLength(100);
  expect(componentText(f.payload())).toContain("up to 100");
  await f.act("watch");
  await f.act("remove");
  const selector = controls(f.payload()).find(
    (item: { type: number }) => item.type === ComponentType.StringSelect,
  );
  expect(selector.options).toHaveLength(25);
  await f.act("next");
  await f.act("remove-channels", "string", [watchedIds[25] as string]);
  expect((await f.starboard()).watch_channels).toEqual(
    watchedIds.slice(0, 100).filter((id) => id !== watchedIds[25]),
  );
});

test("starboard shortcuts validate before saving, preserve siblings, and check concurrent edits", async () => {
  const f = await fixture("starboard");
  const command = createStarboardPlugin().commands?.[0];
  if (!command) throw new Error("Missing command");
  const invoke = (
    action: string,
    value: string | number = "",
    overrides = {},
  ) =>
    command.execute(f.context, {
      ...f.base,
      options: {
        getSubcommand: () => action,
        getChannel: () => ({ id: value }),
        getInteger: () => value,
        getString: () => value,
      },
      ...overrides,
    } as unknown as ChatInputCommandInteraction<"cached">);
  for (const action of [
    "status",
    "channel",
    "threshold",
    "emoji",
    "enable",
    "disable",
  ])
    await expect(
      invoke(action, channelId, {
        memberPermissions: new PermissionsBitField(),
      }),
    ).rejects.toThrow("Manage Server");
  const original = await f.raw();
  await invoke("status");
  expect(await f.raw()).toEqual(original);
  await expect(invoke("enable")).rejects.toThrow("Choose a starboard channel");
  await expect(invoke("channel", deniedId)).rejects.toThrow(
    "cannot view or send",
  );
  await expect(invoke("threshold", 0)).rejects.toThrow();
  await expect(invoke("emoji", "not-an-emoji")).rejects.toThrow(
    "Paste one emoji",
  );
  await invoke("channel", channelId);
  await invoke("threshold", 3);
  await invoke("emoji", "🔥");
  expect(await f.starboard()).toMatchObject({
    channel_id: channelId,
    threshold: 3,
    emoji: "🔥",
    enabled: false,
    custom_note: "Keep me",
  });
  await invoke("enable");
  expect((await f.starboard()).enabled).toBe(true);
  await invoke("disable");
  const fetch = f.guild.channels.fetch.getMockImplementation();
  f.guild.channels.fetch.mockImplementationOnce(async (id) => {
    await f.settings.patch(guildId, "starboard", starboardSchema, {
      threshold: 9,
    });
    return fetch?.(id) ?? null;
  });
  await expect(invoke("channel", privateId)).rejects.toThrow(
    "Settings changed",
  );
  expect((await f.starboard()).channel_id).toBe(channelId);
  expect((await f.starboard()).threshold).toBe(9);
});

test("emoji setup supports Unicode sequences and custom IDs without matching the wrong emoji", async () => {
  const f = await fixture("starboard");
  const guild = f.guild as unknown as Guild;
  for (const emoji of ["⭐", "❤️", "👍🏽", "👨‍👩‍👦", "🇵🇱", "1️⃣"])
    expect(await starboardEmoji(guild, emoji)).toBe(emoji);
  for (const emoji of [
    "",
    "1",
    ":star:",
    "hello",
    "⭐🔥",
    "<@123456789012345678>",
  ])
    await expect(starboardEmoji(guild, emoji)).rejects.toThrow(
      "Paste one emoji",
    );
  await expect(starboardEmoji(guild, "800000000000000099")).rejects.toThrow(
    "available custom emoji",
  );
  expect(
    matchesStarboardEmoji(`<:old_name:${customEmojiId}>`, {
      id: customEmojiId,
      name: "new_name",
    }),
  ).toBe(true);
  expect(matchesStarboardEmoji("⭐️", { id: null, name: "⭐" })).toBe(true);
  expect(matchesStarboardEmoji("⭐", { id: customEmojiId, name: "⭐" })).toBe(
    false,
  );
});
