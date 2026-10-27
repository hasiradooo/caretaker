/**
 * Edit these lines to change the bot's public About Me. Startup appends the
 * running version and last startup time within Discord's 400-character limit.
 * Each array entry becomes a new line. This bio is shared across servers.
 * Preview with `bun run profile:update`, then publish with `--apply`.
 */
export const botProfile = {
    bio: [
        "Server tools for roles, levels, welcome messages, birthdays, and support tickets.",
        "Use /help to get started. Features are configured separately for each server.",
    ].join("\n"),
};
