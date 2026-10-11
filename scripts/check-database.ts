import { readEnvironment } from "../src/config/environment";
import { connectDatabase } from "../src/database/connection";
import { createLogger } from "../src/shared/logger";

const env = readEnvironment();
const log = createLogger("database-check", "info", [
  env.DATABASE_URL,
  env.DISCORD_TOKEN,
  env.MASTER_ENCRYPTION_KEY,
]);
const db = connectDatabase(env);
try {
  await db.transaction(async (tx) => {
    await tx.query("set transaction read only");
    const columns = await tx.query<{
      table_name: string;
      column_name: string;
      data_type: string;
    }>(
      "select table_name,column_name,data_type from information_schema.columns where table_schema='discord' order by table_name,ordinal_position",
    );
    console.log(JSON.stringify({ schema: "discord", columns }, null, 2));
    if (columns.some((column) => column.table_name === "plugins")) {
      console.log(
        JSON.stringify(
          await tx.query(
            "select plugin_name,enabled,count(*)::int as guilds from discord.plugins where bot_id=$1 group by plugin_name,enabled order by plugin_name",
            [env.DISCORD_CLIENT_ID],
          ),
        ),
      );
    }
    if (columns.some((column) => column.table_name === "user_levels")) {
      console.log(
        JSON.stringify(
          await tx.query(
            "select count(*)::int as level_rows,count(*) filter (where xp<0 or level<0 or xp >= (level::bigint+1)*3000)::int as noncanonical_rows from discord.user_levels where bot_id=$1",
            [env.DISCORD_CLIENT_ID],
          ),
        ),
      );
    }
  });
} catch (error) {
  log.error("Read-only database check failed", error);
  process.exitCode = 1;
} finally {
  await db.close();
}
