import { REST, Routes } from "discord.js";
import { readEnvironment } from "../src/config/environment";
import { inspectDiscordAccess } from "../src/core/discord-preflight";
import { createPlugins } from "../src/plugins";
import { createLogger } from "../src/shared/logger";

const commands = createPlugins().flatMap(
    (plugin) => plugin.commands?.map((command) => command.data.toJSON()) ?? [],
);
if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify(commands, null, 2));
    console.log(
        "Preview only. Deploy with bun run commands:deploy --apply; set COMMAND_GUILD_ID for one test server.",
    );
    process.exit(0);
}
const env = readEnvironment();
const rest = new REST({ timeout: 15000, retries: 1 }).setToken(
    env.DISCORD_TOKEN,
);
const log = createLogger("commands", "info", [env.DISCORD_TOKEN]);
try {
    // Check identity and membership before replacing commands in either scope.
    await inspectDiscordAccess(
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
    await rest.put(route, { body: commands });
    // Deploy only the selected scope; never erase global commands during development.
    log.info(
        `Deployed ${commands.length} commands to ${env.COMMAND_GUILD_ID ? "the selected guild" : "global scope"}`,
    );
} catch (error) {
    log.error("Command deployment failed", error);
    process.exitCode = 1;
}
