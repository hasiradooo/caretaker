import { resolve } from "node:path";
import { readEnvironment } from "../src/config/environment";
import { connectDatabase } from "../src/database/connection";
import { migrate } from "../src/database/migrations";
import { createLogger } from "../src/shared/logger";

if (!process.argv.includes("--apply")) {
  console.log(
    "Review migrations/*.sql and back up your database first. Apply with: bun run db:migrate --apply",
  );
  process.exit(0);
}
const env = readEnvironment();
const log = createLogger("migrations", "info", [
  env.DATABASE_URL,
  env.DISCORD_TOKEN,
  env.MASTER_ENCRYPTION_KEY,
]);
const db = connectDatabase(env);
try {
  const applied = await migrate(db, resolve(import.meta.dir, "../migrations"));
  log.info(
    applied.length
      ? `Applied: ${applied.join(", ")}`
      : "Database is up to date",
  );
} catch (error) {
  log.error("Migration failed; transaction rolled back", error);
  process.exitCode = 1;
} finally {
  await db.close();
}
