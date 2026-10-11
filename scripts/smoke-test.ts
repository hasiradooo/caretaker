import { readEnvironment } from "../src/config/environment";
import { startApplication } from "../src/core/application";
import { createLogger } from "../src/shared/logger";

const env = readEnvironment();
const log = createLogger("smoke-test", "info", [
    env.DISCORD_TOKEN,
    env.DATABASE_URL,
    env.MASTER_ENCRYPTION_KEY,
]);
// A hard deadline also covers network failures while cleaning up a failed login.
const deadline = setTimeout(() => {
    log.error("Startup check exceeded 90 seconds");
    process.exit(1);
}, 90000);
try {
    const app = await startApplication(env, { activatePlugins: false });
    try {
        log.info(
            "Discord gateway login, database migrations, bot registration and guild synchronization passed.",
        );
    } finally {
        await app.stop();
    }
} catch (error) {
    log.error("Startup check failed", error);
    process.exitCode = 1;
} finally {
    clearTimeout(deadline);
}
