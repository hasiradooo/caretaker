import { REST, Routes } from "discord.js";
import { readEnvironment } from "../src/config/environment";
import { inspectDiscordAccess } from "../src/core/discord-preflight";
import { createLogger } from "../src/shared/logger";

const env = readEnvironment();
const log = createLogger("discord-check", "info", [env.DISCORD_TOKEN]);
try {
    const rest = new REST({ timeout: 15000, retries: 1 }).setToken(
        env.DISCORD_TOKEN,
    );
    const report = await inspectDiscordAccess(
        rest,
        env.DISCORD_CLIENT_ID,
        env.COMMAND_GUILD_ID,
    );
    const route = env.COMMAND_GUILD_ID
        ? Routes.applicationGuildCommands(
              env.DISCORD_CLIENT_ID,
              env.COMMAND_GUILD_ID,
          )
        : Routes.applicationCommands(env.DISCORD_CLIENT_ID);
    const commands = (await rest.get(route)) as Array<{ name: string }>;
    console.log(
        JSON.stringify(
            {
                ...report,
                commandScope: env.COMMAND_GUILD_ID ?? "global",
                registeredCommands: commands.map((command) => command.name),
            },
            null,
            2,
        ),
    );
    if (report.missingIntents.length) {
        log.error(
            `Enable ${report.missingIntents.join(" and ")} in the Discord Developer Portal's Bot settings.`,
        );
        process.exitCode = 1;
    }
} catch (error) {
    log.error("Discord setup check failed", error);
    process.exitCode = 1;
}
