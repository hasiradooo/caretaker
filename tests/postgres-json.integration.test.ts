import { expect, test } from "bun:test";
import { readEnvironment } from "../src/config/environment";
import { connectDatabase } from "../src/database/connection";
import { SettingsStore } from "../src/database/settings-store";
import { levelsSchema } from "../src/plugins/levels/config";
import { TicketRepository } from "../src/plugins/tickets/repository";
import { TicketReviewRepository } from "../src/plugins/tickets/review-repository";
import { TranscriptRepository } from "../src/plugins/tickets/transcript-repository";

// Opt-in wire-protocol regression: PGlite does not use postgres.js serializers.
// Temporary tables isolate these writes from every real bot/server row.
test.skipIf(process.env.TEST_POSTGRES_JSON !== "1")(
  "postgres.js stores settings and ticket JSON as objects across repeated edits",
  async () => {
    const db = connectDatabase(readEnvironment());
    const bot = "100000000000000001",
      guild = "200000000000000001";
    try {
      await db.transaction(async (tx) => {
        await tx.query(
          "create temporary table caretaker_json_settings (like discord.plugins including all) on commit drop",
        );
        await tx.query(
          "create temporary table caretaker_json_tickets (like discord.tickets including all) on commit drop",
        );
        await tx.query(
          "create temporary table caretaker_json_transcripts (like discord.ticket_transcripts including all) on commit drop",
        );
        // LIKE does not clone triggers. Use a session-local sequence so this
        // serializer test never reads or advances real server ticket counters.
        await tx.query(
          "create temporary sequence caretaker_json_ticket_number",
        );
        await tx.query(
          "alter table pg_temp.caretaker_json_tickets alter column ticket_number set default nextval('pg_temp.caretaker_json_ticket_number')",
        );
        // Run real repositories and the production driver against session-local tables.
        const isolated = {
          ...tx,
          query: <T extends object>(
            statement: string,
            parameters: import("../src/database/connection").Parameter[] = [],
          ) =>
            tx.query<T>(
              statement
                .replaceAll(
                  "discord.ticket_transcripts",
                  "pg_temp.caretaker_json_transcripts",
                )
                .replaceAll(
                  "discord.plugins",
                  "pg_temp.caretaker_json_settings",
                )
                .replaceAll(
                  "discord.tickets",
                  "pg_temp.caretaker_json_tickets",
                ),
              parameters,
            ),
        };
        isolated.transaction = (operation) => operation(isolated);
        const channel = "400000000000000001",
          role = "500000000000000001";
        await new SettingsStore(isolated, bot).patch(
          guild,
          "levels",
          levelsSchema,
          { enabled: true, reward_channel_id: channel },
        );
        for (const level of [5, 10, 15]) {
          await new SettingsStore(isolated, bot).patch(
            guild,
            "levels",
            levelsSchema,
            { reward_roles: [{ role_id: role, level }] },
          );
          const stored = await new SettingsStore(isolated, bot).get(
            guild,
            "levels",
            levelsSchema,
          );
          expect(stored.reward_channel_id).toBe(channel);
          expect(stored.reward_roles).toEqual([{ role_id: role, level }]);
          const [row] = await tx.query<{ kind: string; bytes: number }>(
            "select jsonb_typeof(config) as kind,octet_length(config::text) as bytes from pg_temp.caretaker_json_settings",
          );
          expect(row?.kind).toBe("object");
          expect(row?.bytes).toBeLessThan(1500);
        }
        await new TicketRepository(isolated, bot).create(
          guild,
          channel,
          "300000000000000001",
          "JSON round trip 🐇",
        );
        const [ticket] = await tx.query<{
          kind: string;
          metadata: { topic: string };
        }>(
          "select jsonb_typeof(metadata) as kind,metadata from pg_temp.caretaker_json_tickets",
        );
        expect(ticket?.kind).toBe("object");
        expect(ticket?.metadata.topic).toBe("JSON round trip 🐇");
        const tickets = new TicketRepository(isolated, bot);
        const created = await tickets.get(guild, channel);
        if (!created) throw new Error("New ticket missing");
        // PostgreSQL now() includes microseconds; the driver's Date would round
        // those away and break the activity comparison for brand-new tickets.
        expect(
          await tickets.saveWarning(
            guild,
            created,
            "initial",
            new Date(),
            new Date(Date.now() + 1800000),
            "800000000000000003",
          ),
        ).toBe(true);
        const activity = new Date(Date.now() + 1000);
        await tickets.touch(guild, channel, "300000000000000001", activity);
        const ongoing = await tickets.get(guild, channel);
        if (!ongoing) throw new Error("Ticket not found");
        expect(
          await tickets.saveWarning(
            guild,
            ongoing,
            "259200000:1800000",
            activity,
            new Date(activity.getTime() + 1800000),
            "800000000000000002",
          ),
        ).toBe(true);
        const warned = await tickets.get(guild, channel);
        if (!warned) throw new Error("Warning not saved");
        expect(warned.inactivity_policy).toBe("259200000:1800000");
        await tickets.touch(
          guild,
          channel,
          "300000000000000001",
          new Date(activity.getTime() + 1),
        );
        expect(
          await tickets.close(guild, channel, bot, "Inactive", warned),
        ).toBe(false);
        expect(
          (await tickets.get(guild, channel))?.inactivity_close_at,
        ).toBeNull();
        await tickets.close(guild, channel, bot, "Resolved");
        const reviews = new TicketReviewRepository(isolated, bot);
        const review = await reviews.claim(guild, channel);
        expect(review?.ticket_number).toBe("1");
        if (!review) throw new Error("Review claim failed");
        await reviews.delivery(
          review.review_token,
          "sent",
          "800000000000000001",
        );
        expect(
          (await reviews.find(review.review_token, "300000000000000001"))
            ?.review_dm_message_id,
        ).toBe("800000000000000001");
        expect(
          (await reviews.rate(review.review_token, "300000000000000001", 4))
            ?.rating,
        ).toBe(4);
        expect(
          (await reviews.rate(review.review_token, "300000000000000001", 5))
            ?.rating,
        ).toBe(4);
        expect(await reviews.claim(guild, channel)).toBeUndefined();
        const transcripts = new TranscriptRepository(isolated, bot);
        await transcripts.prepare(guild, channel, "400000000000000002", {
          server_name: "Backrooms",
          names: {},
          complete: true,
          messages: [],
        });
        const archive = await transcripts.get(guild, channel);
        expect(archive?.snapshot).toEqual({
          server_name: "Backrooms",
          names: {},
          complete: true,
          messages: [],
        });
        expect(await transcripts.pending(guild)).toHaveLength(1);
        if (!archive) throw new Error("Transcript not found");
        await transcripts.published(archive, "900000000000000001");
        expect(await transcripts.pending(guild)).toHaveLength(0);
      });
    } finally {
      await db.close();
    }
  },
  30000,
);
