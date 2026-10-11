import { expect, mock, test } from "bun:test";
import {
  type ChatInputCommandInteraction,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import { createPlugins } from "../src/plugins";
import { createHelpCommand } from "../src/plugins/configuration/help";
import { type card, componentText } from "../src/shared/messages";

async function help(admin: boolean, enabled: string[]) {
  const plugins = createPlugins().filter(
    (plugin) => plugin.id !== "configuration",
  );
  const editReply = mock(async (_reply: ReturnType<typeof card>) => undefined);
  await createHelpCommand(plugins).execute(
    {
      env: { BOT_NAME: "Caretaker" },
      settings: {
        raw: async (_guild: string, id: string) => ({
          enabled: enabled.includes(id),
        }),
      },
    } as unknown as Context,
    {
      guildId: "guild",
      memberPermissions: new PermissionsBitField(
        admin ? PermissionFlagsBits.ManageGuild : 0n,
      ),
      editReply,
    } as unknown as ChatInputCommandInteraction<"cached">,
  );
  const reply = editReply.mock.calls[0]?.[0];
  expect(reply?.flags).toBe(MessageFlags.IsComponentsV2);
  expect(reply).not.toHaveProperty("content");
  // Serialize through discord.js validation, then read the nested text.
  return {
    content: componentText({
      components: reply?.components.map((component) => component.toJSON()),
    }),
  };
}

test("member help exposes active commands and retains birthday removal", async () => {
  const reply = await help(false, ["levels"]);
  expect(reply.content).toContain("/level rank");
  expect(reply.content).toContain("/birthday remove");
  expect(reply.content).not.toContain("/ticket open");
  expect(reply.content).not.toContain("Server setup");
});

test("administrator help explains first setup when all features are disabled", async () => {
  const reply = await help(true, []);
  expect(reply.content).toContain("not enabled yet");
  expect(reply.content).toContain("/config view");
  expect(reply.content).toContain("Server setup");
  expect(reply.content.length).toBeLessThanOrEqual(4000);
});
