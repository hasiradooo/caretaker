import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { migrate } from "../src/database/migrations";
import { TicketRepository } from "../src/plugins/tickets/repository";
import { emptyDatabase, testDatabase } from "./helpers/database";

test("migration numbers old tickets in creation order without replacing their history", async () => {
    const db = await emptyDatabase();
    const migrations = `${import.meta.dir}/../migrations`;
    try {
        await db.query(
            await readFile(
                `${import.meta.dir}/../database/baseline.sql`,
                "utf8",
            ),
        );
        await db.query(`insert into discord.tickets
      (bot_id,guild_id,thread_id,opener_id,status,created_at,metadata)
      values
      ('bot','guild','newer','same-member','open','2026-02-02','{"topic":"Current request"}'),
      ('bot','guild','older','same-member','closed','2026-01-01','{"topic":"Old request","custom":true}'),
      ('bot','other-guild','another-server','same-member','closed','2026-01-01','{}'),
      ('other-bot','guild','another-bot','same-member','closed','2026-01-01','{}')`);
        const selectHistory = `select bot_id,guild_id,thread_id,opener_id,status,created_at,metadata
      from discord.tickets order by bot_id,guild_id,thread_id`;
        const history = await db.query(selectHistory);
        expect(await migrate(db, migrations)).toContain(
            "004_ticket_numbers.sql",
        );
        expect(await db.query(selectHistory)).toEqual(history);
        const repository = new TicketRepository(db, "bot");
        expect((await repository.get("guild", "older"))?.ticket_number).toBe(
            "1",
        );
        expect((await repository.get("guild", "newer"))?.ticket_number).toBe(
            "2",
        );
        expect(
            (await repository.get("other-guild", "another-server"))
                ?.ticket_number,
        ).toBe("1");
        expect(
            (
                await new TicketRepository(db, "other-bot").get(
                    "guild",
                    "another-bot",
                )
            )?.ticket_number,
        ).toBe("1");
        expect(await migrate(db, migrations)).toEqual([]);
        expect(
            (
                await repository.create(
                    "guild",
                    "next",
                    "other-member",
                    "Next request",
                )
            ).ticket_number,
        ).toBe("3");
        expect((await repository.get("guild", "older"))?.ticket_number).toBe(
            "1",
        );
    } finally {
        await db.close();
    }
}, 30000);

test("parallel inserts allocate unique numbers per server and never reuse deleted numbers", async () => {
    const db = await testDatabase();
    try {
        const tickets = new TicketRepository(db, "bot");
        const rows = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                tickets.create(
                    "guild",
                    `thread-${index}`,
                    `member-${index}`,
                    "Concurrent request",
                ),
            ),
        );
        expect(
            rows.map((row) => Number(row.ticket_number)).sort((a, b) => a - b),
        ).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
        expect(
            (
                await tickets.create(
                    "other-guild",
                    "thread",
                    "member",
                    "Other server",
                )
            ).ticket_number,
        ).toBe("1");
        expect(
            (
                await new TicketRepository(db, "other-bot").create(
                    "guild",
                    "thread",
                    "member",
                    "Other bot",
                )
            ).ticket_number,
        ).toBe("1");

        // An invalid second open ticket cannot consume a number or release the slot.
        await expect(
            tickets.create("guild", "duplicate", "member-0", "Duplicate"),
        ).rejects.toThrow("idx_caretaker_one_open_ticket");
        await db.query(
            "delete from discord.tickets where bot_id='bot' and guild_id='guild'",
        );
        const next = await new TicketRepository(db, "bot").create(
            "guild",
            "next",
            "member-0",
            "New request",
        );
        expect(next.ticket_number).toBe("13");
    } finally {
        await db.close();
    }
}, 30000);
