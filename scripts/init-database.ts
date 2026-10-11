import { resolve } from "node:path";
import { readEnvironment } from "../src/config/environment";
import { connectDatabase } from "../src/database/connection";
import { initializeDatabase } from "../src/database/initialize";
import { createLogger } from "../src/shared/logger";

if (!process.argv.includes("--apply")) {
  console.log(
    "Creates the discord schema and applies migrations on an empty database. Existing schemas are refused. Review database/baseline.sql, then run: bun run db:init --apply",
  );
  process.exit(0);
}
const env = readEnvironment();
const log = createLogger("database-setup", "info", [
  env.DATABASE_URL,
  env.DISCORD_TOKEN,
  env.MASTER_ENCRYPTION_KEY,
]);
const db = connectDatabase(env);
try {
  const applied = await initializeDatabase(
    db,
    resolve(import.meta.dir, "../database/baseline.sql"),
    resolve(import.meta.dir, "../migrations"),
  );
  log.info(`Database initialized. Applied: ${applied.join(", ")}`);
} catch (error) {
  log.error("Database setup failed; transaction rolled back", error);
  process.exitCode = 1;
} finally {
  await db.close();
}
