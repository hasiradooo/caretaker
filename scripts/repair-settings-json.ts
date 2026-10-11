import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readEnvironment } from "../src/config/environment";
import { connectDatabase } from "../src/database/connection";
import { storedJsonObject } from "../src/database/json";
import { createPlugins } from "../src/plugins";
import { createLogger } from "../src/shared/logger";

const env = readEnvironment();
const db = connectDatabase(env);
const log = createLogger("settings-repair", "info", [
    env.DATABASE_URL,
    env.DISCORD_TOKEN,
    env.MASTER_ENCRYPTION_KEY,
]);
const apply = process.argv.includes("--apply");
try {
    await db.transaction(async (tx) => {
        const rows = await tx.query<{
            guild_id: string;
            plugin_name: string;
            enabled: boolean;
            config: unknown;
            revision: string;
        }>(
            `select guild_id,plugin_name,enabled,config,updated_at::text as revision from discord.plugins where bot_id=$1${apply ? " for update" : ""}`,
            [env.DISCORD_CLIENT_ID],
        );
        const plugins = createPlugins();
        const changes = rows.flatMap((row) => {
            const recovered = storedJsonObject(row.config);
            const plugin = plugins.find(
                (candidate) => candidate.id === row.plugin_name,
            );
            // Validate without replacing unknown fields or injecting schema defaults.
            plugin?.schema.parse({ ...recovered, enabled: row.enabled });
            return JSON.stringify(recovered) === JSON.stringify(row.config)
                ? []
                : [{ row, recovered }];
        });
        for (const { row, recovered } of changes)
            log.info(
                `${row.guild_id}/${row.plugin_name}: ${JSON.stringify(row.config).length} -> ${JSON.stringify(recovered).length} characters`,
            );
        if (!apply || !changes.length) {
            log.info(
                apply
                    ? "No settings need repair."
                    : "Preview only. Use --apply after stopping the bot; a backup is saved before updates.",
            );
            return;
        }
        const backupDirectory = resolve(
            "backups",
            `settings-json-${new Date().toISOString().replaceAll(":", "-")}`,
        );
        await mkdir(backupDirectory, { recursive: true });
        await writeFile(
            resolve(backupDirectory, "before.json"),
            JSON.stringify({
                bot_id: env.DISCORD_CLIENT_ID,
                rows: changes.map(({ row }) => row),
            }),
            { flag: "wx" },
        );
        for (const { row, recovered } of changes) {
            await tx.query(
                "update discord.plugins set config=$4::text::jsonb,updated_at=now() where bot_id=$1 and guild_id=$2 and plugin_name=$3",
                [
                    env.DISCORD_CLIENT_ID,
                    row.guild_id,
                    row.plugin_name,
                    JSON.stringify(recovered),
                ],
            );
        }
        log.info(
            `Repaired ${changes.length} settings rows. Backup: ${backupDirectory}`,
        );
    });
} catch (error) {
    log.error(
        "Settings repair failed; database changes were rolled back",
        error,
    );
    process.exitCode = 1;
} finally {
    await db.close();
}
