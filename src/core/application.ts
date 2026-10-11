import { resolve } from "node:path";
import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type { Environment } from "../config/environment";
import { BotRepository } from "../database/bot-repository";
import { connectDatabase } from "../database/connection";
import { RuntimeLease } from "../database/lease";
import { assertMigrationsCurrent } from "../database/migrations";
import { SettingsStore } from "../database/settings-store";
import { StateStore } from "../database/state-store";
import { startHttpServer } from "../http/server";
import { createPlugins } from "../plugins";
import { noMentions } from "../shared/discord";
import { createLogger } from "../shared/logger";
import type { Context } from "./plugin";
import { PluginRuntime } from "./runtime";

export async function startApplication(
  env: Environment,
  options: { activatePlugins?: boolean } = {},
): Promise<{ stop(): Promise<void> }> {
  const log = createLogger(env.BOT_NAME, env.LOG_LEVEL, [
    env.DISCORD_TOKEN,
    env.DATABASE_URL,
    env.MASTER_ENCRYPTION_KEY,
    env.API_SECRET_KEY ?? "",
  ]);
  const db = connectDatabase(env);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildMessageReactions,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Message,
      Partials.Channel,
      Partials.Reaction,
      Partials.GuildMember,
      Partials.User,
    ],
    allowedMentions: noMentions,
    presence: {
      status: "online",
      activities: [
        { type: ActivityType.Custom, name: `${env.BOT_NAME} · /config` },
      ],
    },
  });
  const context: Context = {
    client,
    botId: env.DISCORD_CLIENT_ID,
    env,
    db,
    settings: new SettingsStore(db, env.DISCORD_CLIENT_ID),
    state: new StateStore(db, env.DISCORD_CLIENT_ID),
    log,
  };
  const plugins = createPlugins();
  const runtime = new PluginRuntime(context, plugins);
  const bots = new BotRepository(db, env.DISCORD_CLIENT_ID);
  const lease = new RuntimeLease(db, env.DISCORD_CLIENT_ID);
  let hasLease = false;
  let leaseTimer: ReturnType<typeof setInterval> | undefined;
  let leaseTask: Promise<void> | undefined;
  let http: ReturnType<typeof startHttpServer> | undefined;
  let cleanupTimer: ReturnType<typeof setInterval> | undefined;
  let stopPromise: Promise<void> | undefined;
  let synced = false;
  let cleanupTask: Promise<void> | undefined;
  let stopping = false;
  let readyTask: Promise<void> | undefined;
  const guildTasks = new Set<Promise<void>>();
  const syncGuild = (guild: import("discord.js").Guild) => {
    if (stopping) return;
    const task = bots
      .syncGuild(guild)
      .catch((error: unknown) => log.error("Guild sync failed", error));
    guildTasks.add(task);
    void task.finally(() => guildTasks.delete(task));
  };
  const stop = () => {
    stopping = true;
    stopPromise ??= (async () => {
      if (cleanupTimer) clearInterval(cleanupTimer);
      if (leaseTimer) clearInterval(leaseTimer);
      client.off(Events.GuildCreate, syncGuild);
      // Every cleanup step must run even when an earlier step fails.
      const safely = async (
        name: string,
        task: () => unknown | Promise<unknown>,
      ) => {
        try {
          await task();
        } catch (error) {
          log.warn(`Shutdown: ${name} failed`, error);
        }
      };
      await safely("HTTP", () => http?.stop(true));
      await safely("startup", () => readyTask);
      await safely("plugins", () => runtime.stop());
      await cleanupTask;
      await leaseTask;
      await Promise.allSettled(guildTasks);
      await safely("Discord", () => client.destroy());
      if (synced)
        await bots
          .stopped()
          .catch((error: unknown) =>
            log.warn("Could not update bot status", error),
          );
      if (hasLease)
        await lease
          .release()
          .catch((error: unknown) =>
            log.warn("Could not release runtime lease", error),
          );
      await safely("database", () => db.close());
      log.info("Shutdown complete");
    })();
    return stopPromise;
  };
  try {
    await assertMigrationsCurrent(db, resolve("migrations"));
    hasLease = await lease.acquire();
    if (!hasLease)
      throw new Error(
        "Another Caretaker process is already running for this bot. Stop it first or wait for its lease to expire.",
      );
    // One running gateway client per bot ID. Database writes are still transactional.
    client.on(Events.Error, (error) =>
      log.error("Discord client error", error),
    );
    client.on(Events.Warn, (warning) => log.warn(warning));
    const ready = new Promise<void>((resolve, reject) => {
      client.once(Events.ClientReady, (connected) => {
        readyTask = bots
          .sync(connected, env)
          .then(() => {
            synced = true;
            if (stopping) return;
            // Smoke tests connect and synchronize, but never register handlers
            // or schedules that could send messages or change server resources.
            if (options.activatePlugins !== false) runtime.start();
            resolve();
          })
          .catch(reject);
      });
    });
    // Attach the handler before login; attaching after login can miss ClientReady.
    const login = client.login(env.DISCORD_TOKEN);
    let startupTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([login, ready]),
        new Promise<never>((_resolve, reject) => {
          startupTimeout = setTimeout(
            () =>
              reject(new Error("Discord startup timed out after 60 seconds")),
            60000,
          );
        }),
      ]);
    } finally {
      if (startupTimeout) clearTimeout(startupTimeout);
    }
    client.on(Events.GuildCreate, syncGuild);
    if (env.HTTP_ENABLED && options.activatePlugins !== false)
      http = startHttpServer(context, plugins);
    leaseTimer = setInterval(() => {
      if (leaseTask) return;
      leaseTask = lease
        .renew()
        .then((renewed) => {
          if (!renewed) throw new Error("Runtime lease lost");
        })
        .catch((error: unknown) => {
          log.error(
            "Runtime lease failed; stopping to avoid duplicate processing",
            error,
          );
          process.exitCode = 1;
          // Do not await stop here: stop waits for this renewal task to finish.
          void stop();
        })
        .finally(() => {
          leaseTask = undefined;
        });
    }, 30000);
    leaseTimer.unref();
    cleanupTimer = setInterval(() => {
      if (cleanupTask) return;
      cleanupTask = context.state
        .prune()
        .catch((error: unknown) => log.warn("State cleanup failed", error))
        .finally(() => {
          cleanupTask = undefined;
        });
    }, 3600000);
    cleanupTimer.unref();
    log.info(
      options.activatePlugins === false
        ? `Startup check ready in ${client.guilds.cache.size} server(s); plugin actions disabled`
        : `Ready in ${client.guilds.cache.size} server(s), ${plugins.length - 1} feature plugins loaded`,
    );
    return { stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
