# Caretaker

A modular Discord bot built with TypeScript, Bun, discord.js and PostgreSQL.
Defaults use simple, neutral messages. Every server has its own settings,
roles, channels and member data; feature plugins start disabled until configured.

## Start here

1. Install Bun 1.4 or newer and run `bun install --frozen-lockfile` in this folder.
2. Keep your existing `.env` when upgrading. For a new installation, copy
   `.env.example` to `.env` and fill in the required values.
3. Follow [Aiven database setup](docs/DATABASE.md). A new database uses
   `bun run db:init --apply`; an existing `discord` schema uses
   `bun run db:migrate --apply`. Both commands are preview-only without `--apply`.
4. In the Discord Developer Portal, enable **Server Members Intent** and
   **Message Content Intent** for your bot. Install with the `bot` and
   `applications.commands` scopes. Place the bot's role above roles it should assign.
5. Set `COMMAND_GUILD_ID` to your test server ID. Preview slash commands with
   `bun run commands:deploy`, then deploy with `bun run commands:deploy --apply`.
6. Run `bun run discord:check` to check your bot identity, intents, server
   membership and command registration. `bun run bot:smoke` tests a real gateway
   login and database synchronization, then disconnects without activating plugins.
7. Run `bun start`, then `/help` or `/config list` in Discord. New feature plugins start
   disabled. Configure destinations and roles before enabling them.

The database is hosted by Aiven; the bot process still needs a running computer
or server. Run one process per Discord application. A database lease rejects
duplicate starts and expires after two minutes if a process crashes.

## Features

| Plugin ID | Features | Main command |
| --- | --- | --- |
| `levels` | Message XP, cooldown, role multipliers, rewards, server leaderboard | `/level` |
| `welcome_goodbye` | Welcome/goodbye editor, private previews, channels and automatic join roles | `/welcome settings`, `/goodbye settings` (also `set`, `channel`, `message`, `preview`) |
| `roles` | Persistent self-role selection panel | `/roles` |
| `birthday` | Opt-in birthdays, time zones, private removal and an admin editor | `/birthday set/show/remove/settings` |
| `tickets` | Private support threads, one ongoing ticket per member, staff-only closing and an admin editor | `/ticket open/close/claim/panel/settings` |
| `starboard` | Reaction highlights, an admin editor and private previews | `/starboard settings` (also `status`, `channel`, `threshold`, `emoji`, `enable`, `disable`) |
| `tempvc` | Join-to-create voice channels and empty-room cleanup | `/config` |
| `slowmode` | Temporary slowmode based on activity; restores the prior rate | `/config` |
| `moderation` | Custom rules for new messages and edits, with exceptions and action logs | `/moderation settings` |
| `auto_ban_bots` | Quarantine role bans for bots or all accounts, allowlist and optional bot join bans | `/botguard settings` |

`/config` requires Manage Server permission. Use `/config view` to inspect and
edit settings, `/config set` for one field, and `/config enable` or `disable` to
control a feature. Successful `/level rank` and `/level leaderboard` results are
public, while errors (including attempts in the wrong channel) stay private. Other
commands reply privately. Ranks and leaderboards use display names without
pinging members. Level-up announcements mention the member in the configured
channel. Open `/level settings` for one private editor with
**Rewards**, **Announcements**, **XP settings**, and **Commands** buttons. Add and edit rewards
(including level 0), set the announcement channel/text, adjust XP gain/cooldown,
and enable or pause levels without separate setup commands. Under **Commands**,
choose a dedicated channel for rank and leaderboard, or use **Allow anywhere**
to remove the restriction. Admin setup commands still work in other channels.
Members retain only the roles at their highest unlocked milestone. Rewards update on the next XP award
or admin XP change. Greetings, panels and announcements go to their
configured channels.

Open `/moderation settings` to build rules using **When → Condition → Action**.
For example, choose **Message edited → Contains a link → Delete message** to
check edits even to old, uncached messages. You can also match invites, chosen
words or domains, attachments and mention counts; restrict rules to channels or
roles; and choose deletion, deletion with a timeout, or logging only. New rules
and moderation start disabled. Settings are saved separately for each server.
`/botguard settings` manages quarantine role bans for bot accounts or all members,
with an allowlist and a separate switch for future bot joins. Quarantine scope
defaults to bots only; choose **All accounts** to include regular members.
Role changes trigger immediate checks; periodic scans also cover uncached members.
Neither editor enables protection
until an administrator chooses it.

## Make it yours

- [Configuration guide](docs/CONFIGURATION.md): examples, defaults and behavior.
- [Editing and plugin guide](docs/ARCHITECTURE.md): where the code lives and how to add a feature.
- [Database guide](docs/DATABASE.md): Aiven, backups and Supabase data transfer.
- [Upgrade notes](docs/UPGRADE.md): changes from Familiar and current limitations.
- [Optional HTTP API](docs/API.md): backend integration without exposing credentials to browsers.

Customize messages in each feature's editor or with `/config view`.
Server-specific wording is stored in PostgreSQL alongside that server's settings;
it never becomes a shared default. Existing custom messages survive code updates.
New servers start with empty channel/role selections and disabled features.
Set `BOT_NAME` for logs and presence. Rename the actual Discord application and
bot username in the Developer Portal.

Edit `src/config/profile.ts` to change the bot's public **About Me**:

```sh
bun run profile:update         # Offline preview; no Discord changes
bun run profile:update --apply # Save the bio to Discord and verify it
```

The updater uses `DISCORD_TOKEN` and checks that it belongs to `DISCORD_CLIENT_ID`.
It changes only the application's description (the global bot bio), shared across
servers. It does not change names, avatars, or server-specific profile overrides.
The update command preserves the running version footer. Every normal startup
updates **Caretaker build** and **Last start** in the bio while retaining its
existing text. The build combines the package version with a fingerprint of the
running bundle and dependencies, such as `v2.0.0+0123456789ab`; development source
runs show `v2.0.0+dev`. The same version and startup time appear in console logs.
Long bio text is shortened to leave room within Discord's 400-character limit.
Bio update failures are logged and do not stop the bot. Smoke tests skip bio updates.
Discord's [application description guide](https://github.com/discord/discord-api-docs/blob/main/developers/discovery/best-practices.mdx)
documents the 400-character profile description limit.

## Development and deployment

Logs use readable local timestamps, level labels and indented details by default.
Interactive terminals show colors; redirected output stays free of color codes.
Set `LOG_FORMAT=json` for structured log collectors, or `LOG_FORMAT=auto` to use
readable logs in a terminal and JSON when redirected. `LOG_TIMEZONE=Europe/Warsaw`
overrides the computer timezone for readable timestamps; JSON timestamps remain
UTC. `LOG_LEVEL` filters verbosity, and `NO_COLOR=1` disables colors.
Successful moderation actions report account/server details separately from real
errors. Configured secrets are redacted in both formats, including nested details.

```sh
bun run dev       # Restart on source changes; connects to your configured bot/database
bun run validate  # Type checking, formatting/lint, isolated tests, production bundle
bun run format    # Apply the project's formatting rules
bun run db:check  # Read-only database structure and compatibility report
bun run discord:check # Read-only Discord setup report
bun run bot:smoke # Connect, synchronize bot/server records, then disconnect; no plugin actions
```

Tests use real embedded PostgreSQL in memory and fake Discord interactions;
they do not connect to your live services. A Discord test-server smoke test is
still needed before public use. Start commands from the repository root so the
migrations and certificate paths resolve consistently.

For automatic updates from main on Linux, follow the [GitHub deployment guide](docs/LINUX_DEPLOYMENT.md).

For Docker, follow the [build and run guide](docs/DOCKER.md). With your existing
`.env`, certificate and database ready, stop any local bot process and run:

```sh
docker compose up -d --build
docker compose logs --follow --tail=100 bot
```

The image builds the production bundle. Secrets are loaded from `.env` at runtime,
and the `certs/` directory is mounted read-only. Replacing your Aiven CA requires
a restart, not a rebuild. HTTP stays off by default with no published port.

The old social/OAuth, economy, music, sponsor integrations and external webhook
handlers were unfinished placeholders. They are not advertised as working
plugins here. Their stored tables and unknown configuration fields are preserved
for a future implementation.
