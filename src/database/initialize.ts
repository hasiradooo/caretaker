import { readFile } from "node:fs/promises";
import type { Database } from "./connection";
import { migrate } from "./migrations";

/** Bootstrap is deliberately separate from upgrades: never replace an existing schema. */
export async function initializeDatabase(
    db: Database,
    baselinePath: string,
    migrationsDirectory: string,
): Promise<string[]> {
    const baseline = await readFile(baselinePath, "utf8");
    return db.transaction(async (tx) => {
        await tx.query("select pg_advisory_xact_lock(81007142)");
        const [schema] = await tx.query<{ existing: string | null }>(
            "select to_regnamespace('discord')::text as existing",
        );
        if (schema?.existing)
            throw new Error(
                "The discord schema already exists. Use db:migrate to upgrade; db:init never overwrites data.",
            );
        await tx.query(baseline);
        return migrate(tx, migrationsDirectory);
    });
}
