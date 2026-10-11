import { expect, test } from "bun:test";
import {
  Collection,
  type Guild,
  type Message,
  type TextBasedChannel,
} from "discord.js";
import type { TicketRow } from "../src/plugins/tickets/repository";
import {
  ticketDuration,
  transcriptPayload,
} from "../src/plugins/tickets/transcript-presentation";
import type { TicketTranscript } from "../src/plugins/tickets/transcript-repository";
import { captureTranscript } from "../src/plugins/tickets/transcripts";
import { componentText } from "../src/shared/messages";

function transcript(): TicketTranscript {
  return {
    guild_id: "200000000000000001",
    thread_id: "600000000000000001",
    channel_id: "400000000000000001",
    message_id: null,
    revision: 1,
    published_revision: 0,
    published_rating: null,
    ticket_number: "5",
    opener_id: "member",
    claimed_by: "staff",
    closed_by: "admin",
    created_at: "2026-10-10T10:00:00Z",
    closed_at: "2026-10-10T11:02:03Z",
    topic: "Help <script>evil()</script>",
    close_reason: "Solved",
    rating: null,
    reviewed_at: null,
    status: "closed",
    snapshot: {
      server_name: 'Kiro <img src=x onerror="evil()">',
      names: { member: "Wanderer", staff: "Helper", admin: "Admin" },
      complete: true,
      messages: [
        {
          id: "message",
          author_id: "member",
          author_name: "<script>evil()</script>",
          created_at: "2026-10-10T10:01:00Z",
          edited_at: null,
          reply_to: null,
          text: '<script>evil()</script> & <img src="https://tracker.example/image">',
          attachments: [
            { name: "<b>unsafe</b>", url: "javascript:evil()" },
            {
              name: "image.png",
              url: 'https://cdn.discordapp.com/attachments/example.png?x="quoted"',
            },
          ],
        },
      ],
    },
  };
}

test("HTML and text contain the people, timestamps, duration and only submitted reviews", () => {
  const row = transcript();
  let payload = transcriptPayload(row);
  const text = payload.files[1]?.attachment.toString() ?? "";
  expect(text).toContain("Opened by: Wanderer (member)");
  expect(text).toContain("Claimed by: Helper (staff)");
  expect(text).toContain("Closed by: Admin (admin)");
  expect(text).toContain("Duration: 1h 2m");
  expect(text).not.toContain("Member review");
  expect(componentText(payload)).not.toContain("Member review");
  expect(payload).toHaveProperty("allowedMentions.parse", []);
  row.rating = 4;
  row.reviewed_at = "2026-10-10T11:04:00Z";
  payload = transcriptPayload(row);
  expect(componentText(payload)).toContain("⭐ **4/5**");
  for (const file of payload.files)
    expect(file.attachment.toString()).toContain("4/5");
});

test("HTML treats names, messages and filenames as text and rejects executable attachment links", () => {
  const html =
    transcriptPayload(transcript()).files[0]?.attachment.toString() ?? "";
  expect(html).toContain("&lt;script&gt;evil()&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain('href="javascript:');
  expect(html).toContain("&lt;b&gt;unsafe&lt;/b&gt;");
  expect(html).toContain('href="https://cdn.discordapp.com/');
  expect(html).toContain("default-src 'none'");
});

test("capture keeps chronological messages, V2 and legacy text, replies, edits and attachments", async () => {
  const messages = [2, 1].map(
    (n) =>
      ({
        id: String(n),
        author: { id: "member", username: "wanderer", globalName: null },
        member: { displayName: "Wanderer" },
        createdAt: new Date(`2026-10-10T10:0${n}:00Z`),
        editedAt: n === 2 ? new Date("2026-10-10T10:05:00Z") : null,
        reference: n === 2 ? { messageId: "1" } : null,
        content: `Message ${n}`,
        components: [
          { content: "V2 text" },
          {
            type: 13,
            file: {
              url: "https://cdn.discordapp.com/attachments/document.txt",
            },
          },
        ],
        embeds: [
          {
            title: "Old embed",
            description: "Legacy text",
            fields: [{ name: "Field", value: "Value" }],
          },
        ],
        stickers: new Collection(),
        attachments: new Collection([
          ["file", { name: "file.png", url: "https://example.com/file.png" }],
        ]),
      }) as unknown as Message,
  );
  const guild = {
    name: "Backrooms",
    members: { fetch: async () => ({ displayName: "Saved member name" }) },
  } as unknown as Guild;
  const channel = {
    messages: {
      fetch: async () => new Collection(messages.map((m) => [m.id, m])),
    },
  } as unknown as TextBasedChannel;
  const result = await captureTranscript(
    guild,
    channel,
    { opener_id: "member", claimed_by: "staff" } as TicketRow,
    "admin",
  );
  expect(result.messages.map((m) => m.id)).toEqual(["1", "2"]);
  expect(result.messages[1]).toMatchObject({
    reply_to: "1",
    edited_at: "2026-10-10T10:05:00.000Z",
  });
  expect(result.messages[0]?.text).toContain(
    "V2 text\nOld embed\nLegacy text\nField\nValue",
  );
  expect(result.names.staff).toBe("Saved member name");
  expect(result.messages[0]?.attachments.map((a) => a.name)).toEqual([
    "file.png",
    "document.txt",
  ]);
  expect(result.complete).toBe(true);
});

test("duration clamps invalid ordering and oversized exports fail before publication", () => {
  expect(ticketDuration("2026-10-10T10:00:00Z", "2026-10-10T09:00:00Z")).toBe(
    "0s",
  );
  const row = transcript();
  const message = row.snapshot.messages[0];
  if (!message) throw new Error("Missing message");
  message.text = "x".repeat(4_000_000);
  expect(() => transcriptPayload(row)).toThrow("exceed 7 MB");
});
