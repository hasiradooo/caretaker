import { readEnvironment } from "./config/environment";
import { startApplication } from "./core/application";
import { createLogger } from "./shared/logger";

/** Only this entry point starts external connections; every other module is import-safe. */
async function main(): Promise<void> {
    const env = readEnvironment();
    const log = createLogger("lifecycle", env.LOG_LEVEL, [
        env.DISCORD_TOKEN,
        env.DATABASE_URL,
        env.MASTER_ENCRYPTION_KEY,
        env.API_SECRET_KEY ?? "",
    ]);
    const app = await startApplication(env);
    let shuttingDown = false;
    const shutdown = async (code: number) => {
        if (shuttingDown) return;
        shuttingDown = true;
        const deadline = setTimeout(() => process.exit(1), 20000);
        deadline.unref();
        try {
            await app.stop();
            process.exitCode = code;
        } catch (error) {
            log.error("Shutdown failed", error);
            process.exitCode = 1;
        } finally {
            clearTimeout(deadline);
        }
    };
    process.once("SIGINT", () => {
        void shutdown(0);
    });
    process.once("SIGTERM", () => {
        void shutdown(0);
    });
    process.on("unhandledRejection", (error) => {
        log.error("Unhandled rejection", error);
        void shutdown(1);
    });
    process.on("uncaughtException", (error) => {
        log.error("Uncaught exception", error);
        void shutdown(1);
    });
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        createLogger("startup", "error", [
            process.env.DISCORD_TOKEN ?? "",
            process.env.DATABASE_URL ?? "",
            process.env.MASTER_ENCRYPTION_KEY ?? "",
        ]).error("Startup failed", error);
        process.exitCode = 1;
    });
}
