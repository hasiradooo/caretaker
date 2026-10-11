# Upgrade from Familiar

The rewrite replaces the previous source tree and setup UI with small feature
modules and one consistent configuration command. Existing plugin IDs and
database columns are retained wherever they already existed.

## Changes

- Startup no longer parses an empty presence string. Configuration is validated
  once with field-specific errors and secrets omitted from logs.
- Birthday SQL uses the actual PostgreSQL client and original day/month/year
  columns. Invalid calendar dates are rejected.
- XP uses the configured gain range, transactional cooldown/update logic and
  the existing residual-XP format. Leaderboards sort by level then residual XP.
- Bot/server scope is enforced on repository queries and API routes.
- Self-role, welcome and earned roles share hierarchy and permission checks.
- `/level rewards add`, `list` and `remove` configure milestone roles without
  editing JSON. Earned roles now follow the old bot's highest-milestone policy:
  on the next eligible XP award or admin XP change, configured lower-tier roles
  are replaced. XP resets remove configured rewards below the first milestone.
  Unrelated roles and roles whose reward mappings were removed are retained.
- Configuration edits preserve nested siblings and unknown legacy fields.
  Stale modal editors cannot overwrite newer settings.
- HTTP is disabled by default and requires an explicit backend secret when
  enabled. Missing authentication never grants access.
- Command deployment is explicit; startup does not replace commands in Discord.
- Container paths, production dependency installation, shutdown and checks are
  defined in the root Dockerfile, compose.yaml and CI workflow.

## Existing installation

Keep `.env` and its original encryption key. The installation backup contains
the previous source/configuration files but deliberately excludes `.env`.
The rewrite does not rename your live Discord application, create server roles
or channels, register commands, or move database rows automatically.

Old stored settings may include malformed values previously accepted by stubs.
`/config view` shows them for repair. Use the new documented schemas as the
reference; unknown fields stay stored but unimplemented options have no effect.
Legacy configuration panels must be republished with the new commands.

## Features intentionally not presented as complete

The previous code included scaffolding for social account linking/OAuth,
economy, music, external support-provider webhooks and dashboard provisioning.
Those integrations need their own product behavior, credentials and tests.
Their database tables survive this upgrade. Unsupported webhook routes now
return 501 and do not pretend an event was processed. There is no new web
dashboard or music player in this rewrite.

## Practical limits

- No live Aiven connection, Discord smoke test or Supabase data transfer is
  implied by local tests. Set up Aiven, import data if available, and test a guild.
- Discord and PostgreSQL cannot commit atomically together. Compensating
  cleanup handles ordinary creation failures, but a process crash between an
  external action and persistence can leave an orphan channel or highlight.
- Birthday claims prevent routine duplicate greetings across restarts. A crash
  or ambiguous send failure after claiming can skip a greeting for that date.
- Ticket transcripts contain at most the latest 10,000 messages and 7 MB.
  Full history remains in the archived channel. Oversized transcripts stop
  closure with an actionable error; messages are not deleted. Discord may
  expire attachment links in exported plain-text transcripts.
- New starboard rows record their destination. Legacy rows cannot recover an
  unknown old destination if that setting was already changed before migration.
  Removed highlights are not automatically rebuilt while the bot is offline;
  a later reaction event updates them.
- Temporary voice expiration is a reuse limit, not a forced disconnect timer.
- Background bot-guard scans use cached members; they are not a full historical
  audit of every bot already in a large server.
- The HTTP API is for a trusted backend with administrative access, not direct
  browser use or member OAuth. Response shapes and command names should be
  checked before reconnecting any existing frontend.

## Rollback

Stop Caretaker first. Restore the saved original source files and original
dependency lockfile, keep `.env`, and reinstall those dependencies. The database
changes are additive; do not drop new columns or tables just to roll back the
source. Redeploy the old commands explicitly if you previously replaced them.
Keep a database backup from before migration for full recovery. Never start the
old and new bot simultaneously against the same Discord application.
