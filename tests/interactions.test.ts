import { expect, mock, test } from "bun:test";
import {
  type ChatInputCommandInteraction,
  Collection,
  type Guild,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import { PluginRuntime } from "../src/core/runtime";
import { createPlugins } from "../src/plugins";
import { assignableRole } from "../src/shared/discord";
import { UserError } from "../src/shared/errors";
import { componentText } from "../src/shared/messages";

test("Manage Server permission is checked at execution, not only command registration", async () => {
  const interaction = {
    commandName: "config",
    inCachedGuild: () => true,
    isRepliable: () => true,
    isChatInputCommand: () => true,
    memberPermissions: new PermissionsBitField(),
    deferred: false,
    replied: false,
    deferReply: mock(async () => {
      interaction.deferred = true;
    }),
    editReply: mock(async (_reply: unknown) => undefined),
    reply: mock(async () => undefined),
  };
  const settings = {
    raw: mock(async () => undefined),
    patch: mock(async () => undefined),
  };
  const context = {
    settings,
    log: { error: mock(() => undefined), warn: mock(() => undefined) },
  } as unknown as Context;
  await new PluginRuntime(context, createPlugins()).dispatch(
    interaction as unknown as ChatInputCommandInteraction,
  );
  expect(settings.raw).not.toHaveBeenCalled();
  expect(settings.patch).not.toHaveBeenCalled();
  const reply = interaction.editReply.mock.calls[0]?.[0];
  expect(componentText(reply)).toContain(
    "You need Manage Server permission to do this.",
  );
  expect(reply).toMatchObject({
    flags: 32768,
    content: null,
    embeds: [],
    attachments: [],
  });
});

test("automatic role assignment rejects administrative and unmanageable roles", async () => {
  const role = {
    id: "300000000000000001",
    managed: false,
    permissions: new PermissionsBitField(PermissionFlagsBits.Administrator),
    comparePositionTo: () => -1,
  };
  const guild = {
    id: "200000000000000001",
    roles: { fetch: async () => role },
    members: {
      me: {
        permissions: new PermissionsBitField(PermissionFlagsBits.ManageRoles),
        roles: { highest: {} },
      },
    },
  } as unknown as Guild;
  await expect(assignableRole(guild, role.id)).rejects.toThrow(
    "cannot be assigned",
  );
  role.permissions = new PermissionsBitField();
  expect((await assignableRole(guild, role.id)).id).toBe(role.id);
  role.managed = true;
  await expect(assignableRole(guild, role.id)).rejects.toThrow(
    "cannot be assigned",
  );
});

test("member role panels reject forged options before modifying any role", async () => {
  const plugin = createPlugins().find((item) => item.id === "roles");
  const add = mock(async () => undefined),
    remove = mock(async () => undefined);
  const context = {
    botId: "100000000000000001",
    settings: {
      get: async () => ({
        enabled: true,
        roles: [{ role_id: "300000000000000001", label: "Safe" }],
      }),
    },
  } as unknown as Context;
  const interaction = {
    customId: "roles:select",
    isStringSelectMenu: () => true,
    deferReply: async () => undefined,
    guildId: "200000000000000001",
    user: { id: "400000000000000001" },
    message: { author: { id: context.botId } },
    values: ["300000000000000099"],
    guild: {
      members: {
        fetch: async () => ({
          roles: { add, remove, cache: new Collection() },
        }),
      },
    },
  };
  await expect(
    plugin?.component?.(
      context,
      interaction as unknown as import("discord.js").Interaction<"cached">,
    ),
  ).rejects.toThrow("outdated");
  expect(add).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

test("an error after a V2 reply stays V2 and removes obsolete controls and attachments", async () => {
  const editReply = mock(async (_reply: unknown) => undefined);
  const plugin = createPlugins().find((item) => item.id === "roles");
  if (!plugin) throw new Error("Missing roles plugin");
  const interaction = {
    customId: "roles:select",
    inCachedGuild: () => true,
    isRepliable: () => true,
    isChatInputCommand: () => false,
    isMessageComponent: () => true,
    deferred: false,
    replied: true,
    editReply,
  };
  await new PluginRuntime(
    { log: { error() {}, warn() {} } } as unknown as Context,
    [
      {
        ...plugin,
        component: async () => {
          throw new UserError("Please try again.");
        },
      },
    ],
  ).dispatch(interaction as unknown as import("discord.js").Interaction);
  const payload = editReply.mock.calls[0]?.[0];
  expect(payload).toMatchObject({
    flags: 32768,
    content: null,
    embeds: [],
    attachments: [],
  });
  expect(componentText(payload)).toContain("Please try again.");
});
