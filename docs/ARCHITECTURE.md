# Editing Caretaker

## Where to make changes

| Change | File or folder |
| --- | --- |
| Theme wording | `src/config/presets.ts` |
| One feature's defaults and accepted values | `src/plugins/<feature>/config.ts` |
| Discord commands and events for that feature | `src/plugins/<feature>/index.ts` |
| Feature SQL | Its `repository.ts`, where present |
| Registered plugins | `src/plugins/index.ts` |
| Environment variables | `src/config/environment.ts` and `.env.example` |
| Startup and shutdown | `src/core/application.ts` |
| Dispatch, error replies, schedules | `src/core/runtime.ts` |
| Shared permission checks | `src/shared/discord.ts` |
| Message layouts, icons and progress bars | `src/shared/messages.ts` |
| Database connection and settings | `src/database/` |
| Optional backend API | `src/http/server.ts` |
| Database upgrades | New numbered file in `migrations/` |

Each feature owns its schema, handlers and domain logic. The runtime supplies a
`Context` containing the Discord client, validated environment, database,
settings store, durable state store and logger. Importing a feature does not
connect to external services. Only `src/index.ts` starts the application.

Plugins are code modules; their `enabled` setting is per server. All modules
register their handlers at startup, then check the server setting before acting.
Cleanup of previously created resources can continue after a feature is disabled.

## Add a plugin

1. Create `src/plugins/example/config.ts`. Define a Zod object with
   `...baseSettings`, safe defaults and validation. Use `.passthrough()` to keep
   legacy fields. New features default to disabled.
2. Export a `Plugin` or a factory returning one from `index.ts`. A factory keeps
   queues and other in-memory state separate between runtime instances.
3. Give it a stable `id`, name, description and schema. Register handlers through
   `events.on(...)` and schedules through `events.every(...)`. These wrappers
   catch failures and drain in-flight work at shutdown.
4. Add it once to `createPlugins()` in `src/plugins/index.ts`. It automatically
   appears in the settings editor and command deployment preview.
5. Add focused tests for its meaningful behavior, run `bun run validate`, then
   deploy changed commands to a test server.

```ts
// src/plugins/example/config.ts
import { z } from "zod";
import { baseSettings } from "../../shared/validation";

export const exampleSchema = z.object({
  ...baseSettings,
  greeting: z.string().min(1).max(1800).default("Hello!"),
}).passthrough();
```

The `Plugin` and `EventRegistrar` interfaces in `src/core/plugin.ts` are the
extension contract. Avoid a new framework or inheritance hierarchy for a small
feature. Larger features can split services and repositories as tickets do.

## Message design (Components V2)

All bot messages use the shared `card()` helper to compose an open Components V2
layout: emoji・headings, small dividers, optional avatar thumbnails, media, file
downloads and controls. These are top-level Text Displays, Sections, Separators,
Action Rows, Media Galleries and Files. Do not wrap them in a Container: that
adds an embed-like box and colored edge. No legacy embeds are used.
Edit this helper to restyle every plugin. Wording and existing server templates
stay with their feature. No additional component library is needed.

```ts
await interaction.editReply(card({
  title: "Support desk",
  icon: "🎫",
  body: "How can we help?",
  sections: ["### Next step\nDescribe the problem in your ticket."],
  footer: "Only you can see this reply",
}));
```

The helper sets `IsComponentsV2` and disables mentions by default. Do not add
legacy `content` or `embeds` to it. When converting an old message with an edit,
clear those fields with `content: null, embeds: []`. Keep the ephemeral flag on
the initial reply/defer; edits only set the V2 flag. For uploads, supply both
`files` on the payload and matching `fileNames` in the card, otherwise Discord
will hide the attachments. Text is bounded across the whole card; the footer
is reserved before trimming. Keep essential instructions before long content.
The helper bounds sections, controls and files below the 40-component limit.

New role and ticket panels use V2; publish replacements with `/roles` and
`/ticket panel` when wanted. Previously posted panels retain their appearance
and remain usable. Starboard entries convert when their reaction count updates.
Ticket transcripts read nested component text as well as legacy message text.

See [Discord's component reference](https://docs.discord.com/developers/components/reference)
for the message format and supported layout elements.

## Conventions that matter

- Scope every member or configuration query by `bot_id` and `guild_id`; a user
  ID alone is not a tenant boundary. Parameterize values with `$1`, `$2`, etc.
- Fetch configured channels and roles through the relevant guild. Check
  permissions when an action executes, including component interactions.
- Automatic role assignment goes through `assignableRole` or `addSafeRole`.
  They reject privileged, managed, everyone and higher-ranking roles.
- Use `context.settings.patch()` for writes. It validates the complete merged
  configuration inside a transaction and invalidates the local cache. Arrays
  replace as a whole; nested objects merge. The modal editor also checks its
  stored revision so an old editor cannot overwrite a newer change.
- The settings cache lasts 15 seconds and is bounded. Direct SQL edits may take
  that long to appear. Required malformed legacy settings fail visibly rather
  than silently becoming defaults.
- Concurrent cache misses share one query. A configuration write invalidates
  in-flight reads as well as cached results, so an old read cannot recache its
  snapshot after an administrator saves newer settings.
- Slash commands are deferred by the runtime before handlers run. Reply with
  `editReply`. They are private by default; a command's synchronous `visibility`
  callback may choose a public reply before the defer. `/level rank` and
  `/level leaderboard` are public; XP management replies remain private.
  Components acknowledge themselves because opening a modal and
  deferring a message are different Discord operations.
- Throw `UserError` for a useful member-facing explanation. Other exceptions
  are logged and produce a generic reply. Never log `.env`, raw credentials or
  whole Discord request objects.
- Use `noMentions` for user-provided text. Explicitly allow just the intended
  member for greetings. Templates perform one literal replacement pass.
- Use row locks for concurrent database updates and `KeyedQueue` for related
  Discord operations. A schedule never overlaps itself. Avoid untracked timers
  or fire-and-forget writes in plugins.
- Never edit an applied migration. Add a new numbered migration. The baseline
  is for new databases only; upgrades must work against existing records.

Comments explain compatibility constraints, ownership and failure behavior.
Keep names direct and functions focused; avoid comments that merely restate a
line of code.

## Verification

`bun run validate` checks TypeScript, Biome, isolated PostgreSQL tests and the
production bundle. Tests exercise tenant separation, XP boundaries and races,
configuration merge/conflicts, calendar validation, API access and role permissions.
PGlite serializes its connection, so the simultaneous-award test checks the
repository contract but does not replace a real multi-connection load test.

`bun run discord:check` uses read-only REST requests to check the application ID,
enabled gateway intents, server membership and registered command names.
`bun run bot:smoke` checks the real gateway connection and database setup, writes
the bot/server registration records, then releases the runtime lease and exits.
It deliberately leaves plugin handlers, schedules and HTTP unregistered, even
if some features are enabled in an existing database. A passing startup check
does not replace interaction tests inside your test server.

For a live test, use a separate Discord guild and database: exercise join/leave,
one XP award after cooldown, a role panel, ticket open/claim/close, a temporary
voice room, starboard threshold changes and a restart. Validate only the plugins
you intend to enable. Command deployment and database scripts require `--apply`;
neither runs automatically during development tests.
