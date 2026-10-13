import { resolve } from "node:path";
import { readEnvironment } from "../src/config/environment";
import { connectDatabase } from "../src/database/connection";
import { assertMigrationsCurrent } from "../src/database/migrations";
import { createLogger } from "../src/shared/logger";

// Check the new image before replacing the running bot, without a Discord login.
const env = readEnvironment();
const log = createLogger("deployment-check", "info", [
    env.DATABASE_URL,
    env.DISCORD_TOKEN,
    env.MASTER_ENCRYPTION_KEY,
    env.API_SECRET_KEY ?? "",
]);
const db = connectDatabase(env);
try {
    await db.transaction(async (tx) => {
        await tx.query("set transaction read only");
        await assertMigrationsCurrent(tx, resolve("migrations"));
    });
    log.info("Database is compatible with this build");
} catch (error) {
    log.error("Deployment check failed; running bot was not replaced", error);
    process.exitCode = 1;
} finally {
    await db.close();
}
