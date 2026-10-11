import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "./connection";

/** Startup only verifies; operators apply schema changes explicitly. */
export async function assertMigrationsCurrent(
  db: Database,
  directory: string,
): Promise<void> {
  const [schema] = await db.query<{ existing: string | null }>(
    "select to_regclass('discord.caretaker_migrations')::text as existing",
  );
  if (!schema?.existing)
    throw new Error(
      "Database setup required. Use db:init for a new database or db:migrate for an existing discord schema. See docs/DATABASE.md.",
    );
  const rows = await db.query<{ name: string; checksum: string }>(
    "select name,checksum from discord.caretaker_migrations",
  );
  const applied = new Map(rows.map((row) => [row.name, row.checksum]));
  for (const name of (await readdir(directory)).filter((file) =>
    /^\d+_[a-z0-9_]+\.sql$/.test(file),
  )) {
    const checksum = createHash("sha256")
      .update(await readFile(join(directory, name), "utf8"))
      .digest("hex");
    if (!applied.has(name))
      throw new Error(
        `Missing migration ${name}. Run bun run db:migrate --apply.`,
      );
    if (applied.get(name) !== checksum)
      throw new Error(`Applied migration changed: ${name}`);
  }
}

export async function migrate(
  db: Database,
  directory: string,
): Promise<string[]> {
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(81007142)");
    const [schema] = await tx.query<{ existing: string | null }>(
      "select to_regclass('discord.user_levels')::text as existing",
    );
    if (!schema?.existing)
      throw new Error(
        "Existing discord schema not found. See docs/DATABASE.md before running migrations.",
      );
    await tx.query(
      "create table if not exists discord.caretaker_migrations (name text primary key, checksum text not null, applied_at timestamptz not null default now())",
    );
    await tx.query(
      "alter table discord.caretaker_migrations enable row level security",
    );
    const applied: string[] = [];
    for (const name of files) {
      const source = await readFile(join(directory, name), "utf8");
      const checksum = createHash("sha256").update(source).digest("hex");
      const [existing] = await tx.query<{ checksum: string }>(
        "select checksum from discord.caretaker_migrations where name=$1",
        [name],
      );
      if (existing) {
        if (existing.checksum !== checksum)
          throw new Error(`Applied migration changed: ${name}`);
        continue;
      }
      // Only checked-in SQL files reach this non-parameterized execution path.
      await tx.query(source);
      await tx.query(
        "insert into discord.caretaker_migrations (name,checksum) values ($1,$2)",
        [name, checksum],
      );
      applied.push(name);
    }
    return applied;
  });
}
