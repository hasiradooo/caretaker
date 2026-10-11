import { REST, Routes } from "discord.js";
import { z } from "zod";
import { botProfile } from "../src/config/profile";
import { createLogger } from "../src/shared/logger";
import { snowflake } from "../src/shared/validation";

// This is an operator command, not a startup hook: normal restarts never replace
// profile edits made in Discord. It needs no database connection or gateway login.
const apply = process.argv.includes("--apply");
const log = createLogger("profile", "info", [process.env.DISCORD_TOKEN ?? ""]);
try {
    const unknown = process.argv.slice(2).filter((arg) => arg !== "--apply");
    if (unknown.length)
        throw new Error("Usage: bun run profile:update [--apply]");
    const result = z.string().trim().min(1).max(400).safeParse(botProfile.bio);
    if (!result.success)
        throw new Error(
            "Set bio in src/config/profile.ts to 1–400 characters.",
        );
    const bio = result.data;
    console.log(
        `Proposed About Me (${bio.length}/400 characters):\n\n${bio}\n`,
    );
    if (!apply) {
        // A preview works offline and never even reads credentials.
        console.log("Preview only. Apply with: bun run profile:update --apply");
    } else {
        const appId = snowflake.safeParse(process.env.DISCORD_CLIENT_ID);
        const token = process.env.DISCORD_TOKEN;
        if (!appId.success || !token?.trim())
            throw new Error(
                "Set DISCORD_CLIENT_ID and DISCORD_TOKEN in .env first.",
            );
        const rest = new REST({ timeout: 15000, retries: 1 }).setToken(token);
        const schema = z.object({
            id: snowflake,
            name: z.string(),
            description: z.string(),
        });
        const route = Routes.currentApplication();
        const current = schema.parse(await rest.get(route));
        // A copied .env must never update a different bot by accident.
        if (current.id !== appId.data)
            throw new Error("DISCORD_CLIENT_ID does not match this bot token.");
        if (current.description === bio) {
            log.info(`${current.name}: About Me is already up to date.`);
        } else {
            // Only description is sent. Naming, images and app settings are separate.
            await rest.patch(route, { body: { description: bio } });
            const saved = schema.parse(await rest.get(route));
            if (saved.id !== current.id || saved.description !== bio)
                throw new Error(
                    "Discord did not return the expected saved bio. Check its profile before retrying.",
                );
            log.info(`${saved.name}: About Me updated and verified.`);
        }
    }
} catch (error) {
    log.error("Profile update failed", error);
    process.exitCode = 1;
}
