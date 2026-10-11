import { expect, mock, test } from "bun:test";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ChatInputCommandInteraction,
  ComponentType,
  MessageFlags,
  PermissionFlagsBits,
  PermissionsBitField,
} from "discord.js";
import type { Context } from "../src/core/plugin";
import { createPlugins } from "../src/plugins";
import {
  card,
  clipText,
  componentText,
  progressBar,
} from "../src/shared/messages";

function walk(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== "object") return [];
  const node = value as Record<string, unknown>;
  return [
    node,
    ...(Array.isArray(node.components) ? node.components.flatMap(walk) : []),
    ...walk(node.accessory),
  ];
}

test("open V2 layouts serialize within API limits without embeds or containers", () => {
  const buttons = Array.from({ length: 3 }, (_, row) =>
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      ...Array.from({ length: 5 }, (_, col) =>
        new ButtonBuilder()
          .setCustomId(`test:${row}:${col}`)
          .setLabel("Action")
          .setStyle(ButtonStyle.Secondary),
      ),
    ),
  );
  const reply = card({
    title: "Test",
    body: "Summary",
    thumbnail: "https://cdn.discordapp.com/embed/avatars/0.png",
    sections: Array.from({ length: 6 }, () => "Section"),
    footer: "Footer",
    image: "https://cdn.discordapp.com/embed/avatars/1.png",
    fileNames: ["settings.json", "history.txt"],
    actions: buttons,
  });
  const nodes = reply.components.flatMap((component) =>
    walk(component.toJSON()),
  );
  expect(nodes.some((node) => node.type === ComponentType.Container)).toBe(
    false,
  );
  expect(reply.components.length).toBeGreaterThan(1);
  expect(nodes.length).toBeLessThanOrEqual(40);
  expect(reply.flags).toBe(MessageFlags.IsComponentsV2);
  expect(reply).not.toHaveProperty("content");
  expect(reply).not.toHaveProperty("embeds");
  expect(reply.allowedMentions.parse).toEqual([]);
  expect(
    nodes
      .filter((node) => node.type === ComponentType.File)
      .map((node) => node.file),
  ).toEqual([
    { url: "attachment://settings.json" },
    { url: "attachment://history.txt" },
  ]);
  expect(
    nodes.filter((node) => node.type === ComponentType.Button),
  ).toHaveLength(15);
});

test("oversized text stays inside the total budget without losing the footer or splitting emoji", () => {
  const reply = card({
    title: "x".repeat(1000),
    body: "🐇".repeat(4000),
    sections: ["Extra"],
    footer: "Next step",
  });
  const texts = reply.components
    .flatMap((component) => walk(component.toJSON()))
    .filter((node) => node.type === ComponentType.TextDisplay)
    .map((node) => String(node.content));
  expect(
    texts.reduce((total, text) => total + text.length, 0),
  ).toBeLessThanOrEqual(4000);
  expect(texts.every((text) => text.length > 0)).toBe(true);
  expect(texts.at(-1)).toContain("Next step");
  expect(clipText("🐇🐇🐇", 4)).toBe("🐇…");
  expect(() =>
    card({ title: "Too many", sections: Array(7).fill("section") }),
  ).toThrow("smaller messages");
});

test("rank progress clamps empty, full and invalid values", () => {
  expect(progressBar(0, 3000)).toContain("0%");
  expect(progressBar(1500, 3000)).toBe("▰▰▰▰▰▰▱▱▱▱▱▱  **50%**");
  expect(progressBar(9999, 3000)).toContain("100%");
  expect(progressBar(Number.NaN, 0)).toContain("0%");
});

test("configuration view exposes the JSON attachment and its editor in the open layout", async () => {
  const plugin = createPlugins().find((item) => item.id === "configuration");
  const command = plugin?.commands?.find(
    (item) => item.data.toJSON().name === "config",
  );
  const editReply = mock(async (_reply: unknown) => undefined);
  await command?.execute(
    {
      settings: {
        raw: async () => ({ enabled: false, config: {}, revision: null }),
      },
    } as unknown as Context,
    {
      guildId: "guild",
      user: { id: "user" },
      memberPermissions: new PermissionsBitField(
        PermissionFlagsBits.ManageGuild,
      ),
      options: { getSubcommand: () => "view", getString: () => "levels" },
      editReply,
    } as unknown as ChatInputCommandInteraction<"cached">,
  );
  const reply = editReply.mock.calls[0]?.[0] as ReturnType<typeof card> & {
    files: { name: string }[];
  };
  const nodes = reply.components.flatMap((component) =>
    walk(component.toJSON()),
  );
  expect(reply.files[0]?.name).toBe("levels.json");
  expect(nodes.find((node) => node.type === ComponentType.File)?.file).toEqual({
    url: "attachment://levels.json",
  });
  expect(
    nodes.find((node) => node.type === ComponentType.Button)?.custom_id,
  ).toMatch(/^configuration:edit:/);
  expect(componentText(reply)).toContain("Disabled");
});

test("transcript extraction retains both legacy text and nested V2 text", () => {
  expect(
    componentText({
      content: "Old message",
      components: card({
        title: "Ticket",
        body: "A question",
        thumbnail: "https://cdn.discordapp.com/embed/avatars/0.png",
        sections: ["Some details"],
      }).components,
    }),
  ).toContain("Old message\n## 🗝️ Ticket\nA question\nSome details");
});
