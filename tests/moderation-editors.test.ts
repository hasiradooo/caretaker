import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import {
  ChannelType,
  type ChatInputCommandInteraction,
  ComponentType,
  type Interaction,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import type { Database } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { createPlugins } from "../src/plugins";
import { botGuardSchema } from "../src/plugins/bot-guard/config";
import { BotGuardSettingsEditor } from "../src/plugins/bot-guard/settings-editor";
import { moderationSchema } from "../src/plugins/moderation/config";
import { ModerationSettingsEditor } from "../src/plugins/moderation/settings-editor";
import { componentText } from "../src/shared/messages";
import { testDatabase } from "./helpers/database";

const botId = "100000000000000001",
  guildId = "200000000000000001",
  userId = "300000000000000001",
  channelId = "400000000000000001",
  roleId = "500000000000000001";
let db: Database;
beforeAll(async () => {
  db = await testDatabase();
}, 30000);
afterAll(async () => {
  await db?.close();
});
const wire = (value: unknown) => JSON.parse(JSON.stringify(value));
const controls = (value: unknown): Array<Record<string, unknown>> =>
  wire(value).components.flatMap(
    (item: { components?: unknown[] }) => item.components ?? [],
  );
function controlId(value: unknown, action: string): string {
  const found = controls(value).find((item) =>
    String(item.custom_id).endsWith(`:${action}`),
  );
  if (!found) throw new Error(`Missing control: ${action}`);
  return String(found.custom_id);
}
function layout(value: unknown) {
  const json = wire(value);
  expect(json.flags).toBe(MessageFlags.IsComponentsV2);
  expect(json).not.toHaveProperty("embeds");
  expect(json.allowedMentions.parse).toEqual([]);
  expect(componentText(json).length).toBeLessThanOrEqual(4000);
  const rows = json.components.filter(
    (row: { type: number }) => row.type === ComponentType.ActionRow,
  );
  expect(rows.length).toBeLessThanOrEqual(3);
  for (const row of rows) expect(row.components.length).toBeLessThanOrEqual(5);
}
async function fixture(kind: "moderation" | "auto_ban_bots" = "moderation") {
  const settings = new SettingsStore(db, botId);
  await settings.patch(guildId, "moderation", moderationSchema, {
    ...moderationSchema.parse({}),
    custom_note: "keep",
  });
  await settings.patch(guildId, "auto_ban_bots", botGuardSchema, {
    ...botGuardSchema.parse({}),
    custom_note: "keep",
  });
  const full = new PermissionsBitField([
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
    PermissionFlagsBits.BanMembers,
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const channel = {
    id: channelId,
    type: ChannelType.GuildText,
    isSendable: () => true,
    isThread: () => false,
    permissionsFor: () => full,
  };
  const guild = {
    id: guildId,
    channels: {
      fetch: mock(async (id: string) => (id === channelId ? channel : null)),
    },
    roles: {
      fetch: mock(async (id: string) => (id === roleId ? { id } : null)),
    },
    members: { me: { permissions: full } },
  };
  let now = 0;
  const editor =
    kind === "moderation"
      ? new ModerationSettingsEditor(() => now)
      : new BotGuardSettingsEditor(() => now);
  const context = { settings, botId } as Context;
  let payload: unknown;
  const base = {
    guildId,
    guild,
    user: { id: userId },
    member: { id: userId, guild },
    memberPermissions: new PermissionsBitField(PermissionFlagsBits.ManageGuild),
    editReply: mock(async (value: unknown) => {
      payload = value;
      layout(value);
    }),
  };
  const open = () =>
    editor.open(
      context,
      base as unknown as ChatInputCommandInteraction<"cached">,
    );
  await open();
  const interaction = (
    customId: string,
    type = "button",
    values: string[] = [],
    fields: Record<string, string> = {},
    overrides = {},
  ) => ({
    ...base,
    customId,
    values,
    message: { author: { id: botId } },
    isMessageComponent: () => type !== "modal",
    isModalSubmit: () => type === "modal",
    isFromMessage: () => true,
    isButton: () => type === "button",
    isStringSelectMenu: () => type === "select",
    isChannelSelectMenu: () => type === "channel",
    isRoleSelectMenu: () => type === "role",
    deferUpdate: mock(async () => {}),
    showModal: mock(async (modal: unknown) => {
      wire(modal);
    }),
    fields: { getTextInputValue: (name: string) => fields[name] ?? "" },
    ...overrides,
  });
  const send = (event: ReturnType<typeof interaction>) =>
    editor.handle(context, event as unknown as Interaction<"cached">);
  const act = async (
    action: string,
    type = "button",
    values: string[] = [],
  ) => {
    const event = interaction(controlId(payload, action), type, values);
    await send(event);
    return event;
  };
  const submit = async (
    shown: Awaited<ReturnType<typeof act>>,
    fields: Record<string, string>,
  ) => {
    const modal = wire(shown.showModal.mock.calls[0]?.[0]);
    await send(interaction(modal.custom_id, "modal", [], fields));
  };
  const saved = () => settings.get(guildId, "moderation", moderationSchema);
  return {
    context,
    settings,
    editor,
    base,
    guild,
    channel,
    open,
    interaction,
    send,
    act,
    submit,
    saved,
    payload: () => payload,
    expire: () => {
      now = 16 * 60000;
    },
  };
}
test("new commands and plugin configuration are registered with admin-only defaults", () => {
  const plugins = createPlugins();
  const commands = plugins.flatMap(
    (plugin) => plugin.commands?.map((command) => command.data.toJSON()) ?? [],
  );
  for (const name of ["moderation", "botguard"]) {
    const command = commands.find((item) => item.name === name);
    expect(command?.default_member_permissions).toBe(
      String(PermissionFlagsBits.ManageGuild),
    );
    expect(command?.options?.some((sub) => sub.name === "settings")).toBe(true);
  }
  expect(new Set(commands.map((item) => item.name)).size).toBe(commands.length);
});
test("an admin builds the edit-link-delete rule without JSON, scopes it and enables it explicitly", async () => {
  const f = await fixture();
  const shown = await f.act("new");
  expect(shown.deferUpdate).not.toHaveBeenCalled();
  expect((await f.saved()).rules).toEqual([]); // Cancelling leaves no half-created rule.
  await f.submit(shown, { name: "No links in edits" });
  let rule = (await f.saved()).rules[0];
  expect(rule).toMatchObject({
    name: "No links in edits",
    enabled: false,
    event: "edit",
    condition: "links",
    action: "delete",
  });
  await f.act("event");
  await f.act("choose", "select", ["both"]);
  await f.act("event");
  await f.act("choose", "select", ["edit"]);
  await f.act("scope");
  await f.act("rule-channels", "channel", [channelId]);
  await f.act("scope");
  await f.act("rule-roles", "role", [roleId]);
  await f.act("rule-toggle");
  rule = (await f.saved()).rules[0];
  expect(rule).toMatchObject({
    enabled: true,
    channels: [channelId],
    roles: [roleId],
  });
  expect((await f.saved()).enabled).toBe(false);
  await f.act("home");
  await f.act("toggle");
  expect(await f.saved()).toMatchObject({ enabled: true, custom_note: "keep" });
  await f.open();
  await f.act("select-rule", "select", [rule?.id ?? ""]);
  await f.act("remove");
  expect((await f.saved()).rules).toEqual([]);
});
test("custom word and domain conditions pause until valid details are supplied", async () => {
  const f = await fixture();
  await f.submit(await f.act("new"), { name: "My rule" });
  const id = (await f.saved()).rules[0]?.id ?? "";
  await f.act("condition");
  await f.act("choose", "select", ["words"]);
  await f.act("rule-toggle");
  expect(componentText(f.payload())).toContain("at least one");
  expect((await f.saved()).rules[0]?.enabled).toBe(false);
  await f.act("select-rule", "select", [id]);
  await f.submit(await f.act("details"), {
    name: "Phrase rule",
    values: "bad phrase\nAnother phrase",
    limit: "5",
    timeout: "15",
  });
  await f.act("action");
  await f.act("choose", "select", ["delete_timeout"]);
  await f.act("rule-toggle");
  expect((await f.saved()).rules[0]).toMatchObject({
    enabled: true,
    condition: "words",
    values: ["bad phrase", "Another phrase"],
    action: "delete_timeout",
    timeout_minutes: 15,
  });
  await f.act("condition");
  await f.act("choose", "select", ["domains"]);
  expect((await f.saved()).rules[0]).toMatchObject({
    enabled: false,
    values: [],
  });
});
test("exceptions and log destination preserve other settings and reject missing channels", async () => {
  const f = await fixture();
  await f.act("exceptions");
  await f.act("exempt-roles", "role", [roleId]);
  await f.act("exempt-channels", "channel", [channelId]);
  await f.act("staff");
  await f.act("bots");
  expect(await f.saved()).toMatchObject({
    exempt_roles: [roleId],
    exempt_channels: [channelId],
    exempt_staff: false,
    include_bots: true,
  });
  await f.act("home");
  await f.act("logs");
  await f.act("log-channel", "channel", [channelId]);
  expect((await f.saved()).log_channel_id).toBe(channelId);
  await f.act("log-channel", "channel", ["400000000000000099"]);
  expect(componentText(f.payload())).toContain("Choose text");
  expect((await f.saved()).log_channel_id).toBe(channelId);
});
test("both editors reject other users, other guilds, revoked permissions and expired controls", async () => {
  for (const kind of ["moderation", "auto_ban_bots"] as const) {
    const f = await fixture(kind);
    const id = controlId(f.payload(), "toggle");
    for (const overrides of [
      { user: { id: "different" } },
      { guildId: "different" },
      { memberPermissions: new PermissionsBitField() },
      { message: { author: { id: "different" } } },
    ]) {
      const event = f.interaction(id, "button", [], {}, overrides);
      await expect(f.send(event)).rejects.toThrow();
      expect(event.deferUpdate).not.toHaveBeenCalled();
    }
    f.expire();
    await expect(f.send(f.interaction(id))).rejects.toThrow("expired");
  }
});
test("stale rule forms cannot overwrite another administrator and saved controls cannot replay", async () => {
  const f = await fixture();
  const form = await f.act("new");
  await f.settings.patch(guildId, "moderation", moderationSchema, {
    log_channel_id: channelId,
  });
  await f.submit(form, { name: "Stale rule" });
  expect((await f.saved()).rules).toEqual([]);
  expect(componentText(f.payload())).toContain("Settings changed");
  const click = f.interaction(controlId(f.payload(), "toggle"));
  await f.send(click);
  await expect(f.send(click)).rejects.toThrow("outdated");
});
test("bot guard edits allowlist, join policy, quarantine roles and history options independently", async () => {
  const f = await fixture("auto_ban_bots");
  const read = () => f.settings.get(guildId, "auto_ban_bots", botGuardSchema);
  await f.submit(await f.act("allow"), { ids: `${userId}\n${botId}` });
  await f.act("join");
  expect(await read()).toMatchObject({
    enabled: false,
    ban_on_join: true,
    allowed_bot_ids: [userId, botId],
  });
  await f.act("quarantine");
  expect(componentText(f.payload())).toContain("Bot accounts only");
  await f.act("targets", "select", ["all"]);
  expect(componentText(f.payload())).toContain(
    "All accounts (members and bots)",
  );
  expect(componentText(f.payload())).toContain("not a delay");
  await f.act("roles", "role", [roleId]);
  await f.act("home");
  await f.submit(await f.act("options"), { days: "1", interval: "15" });
  await f.act("toggle");
  expect(await read()).toMatchObject({
    enabled: true,
    delete_message_days: 1,
    ban_check_interval_minutes: 15,
    watch_roles: [roleId],
    quarantine_targets: "all",
    custom_note: "keep",
  });
});

test("moderation permits channel-specific deletion permissions and checks timeout permission before activation", async () => {
  const f = await fixture();
  f.guild.members.me.permissions.remove(
    PermissionFlagsBits.ManageMessages,
    PermissionFlagsBits.ModerateMembers,
  );
  await f.submit(await f.act("new"), { name: "Scoped link check" });
  const id = (await f.saved()).rules[0]?.id ?? "";
  await f.act("rule-toggle");
  await f.act("home");
  await f.act("toggle");
  expect((await f.saved()).enabled).toBe(true);
  await f.act("select-rule", "select", [id]);
  await f.act("action");
  await f.act("choose", "select", ["delete_timeout"]);
  expect(componentText(f.payload())).toContain("Moderate Members");
  expect((await f.saved()).rules[0]?.action).toBe("delete");
  f.guild.members.me.permissions.add(PermissionFlagsBits.ModerateMembers);
  await f.act("select-rule", "select", [id]);
  await f.act("action");
  await f.act("choose", "select", ["delete_timeout"]);
  expect((await f.saved()).rules[0]?.action).toBe("delete_timeout");
});
