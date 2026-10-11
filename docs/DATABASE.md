# PostgreSQL and Aiven

Caretaker uses ordinary PostgreSQL 15+ and the original `discord` schema. It
does not need the Supabase JavaScript SDK, Auth service, REST API or storage.

## Aiven setup

1. Create **Aiven for PostgreSQL** with the **Free** plan in the
   [Aiven console](https://console.aiven.io/). Select the free plan explicitly;
   a paid service using trial credits is different.
2. Wait until the service is running. From its overview, copy the **Service URI**
   into `DATABASE_URL` in your local `.env`. Preserve the password, port and
   database name supplied by Aiven (usually `defaultdb`). Do not post the URI in chat.
3. Download the project's **CA certificate** from the same service overview.
   Save it to `certs/aiven-ca.pem` inside this bot folder.
4. Add these settings to `.env`, replacing any previous provider's CA path:

   ```dotenv
   DATABASE_SSL=verify-full
   DATABASE_CA_FILE=certs/aiven-ca.pem
   DATABASE_POOL_SIZE=5
   ```

5. Keep `DISCORD_TOKEN`, `DISCORD_CLIENT_ID` and `MASTER_ENCRYPTION_KEY` unchanged
   when moving the existing bot. For a genuinely new installation, create a key
   once with `bun -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`
   and save it as `MASTER_ENCRYPTION_KEY`. Never regenerate the key for existing
   encrypted records.
6. Run `bun run db:check`. An empty list of `discord` tables is normal before
   initialization. A certificate error means the CA file or path needs fixing;
   keep verification enabled.

Aiven PostgreSQL requires its project CA for full certificate verification.
Caretaker uses the supplied CA and verifies the host, even if the URI says
`sslmode=require`. See [Aiven's certificate documentation](https://aiven.io/docs/platform/concepts/tls-ssl-certificates)
and [connection guide](https://aiven.io/docs/products/postgresql/howto/connect-node).
Free service availability and inactivity rules are described in
[Aiven's plan documentation](https://aiven.io/docs/platform/concepts/service-pricing#free-tier).

## Fresh database

```sh
bun run db:init          # Explain the operation; no connection or writes
bun run db:init --apply  # Create the baseline and apply all migrations atomically
bun run db:check
```

The initializer refuses **any existing `discord` schema**, including an empty
one. It never drops or replaces a schema. It creates the original tables plus
Caretaker's additions without Supabase-only roles, policies or extensions.
Run using the database owner (Aiven's `avnadmin` service user can create and own
this schema); use that same user for the bot unless you explicitly provision a
separate server-side role. Tables have RLS enabled and no public access grants.
Application queries also scope data by bot and server IDs.

When using Docker, the equivalent setup command is
`docker compose run --rm bot bun run db:init --apply`.

## Existing database

Stop the old bot and take a database backup before applying upgrades.

```sh
bun run db:check
bun run db:migrate
bun run db:migrate --apply
```

Migrations are additive, ordered and checksum-checked. They preserve existing
XP, birthdays, settings and unrelated feature tables. Migration 001 adds XP
cooldown timestamps, ticket activity timestamps, indexes and runtime state;
migration 002 records starboard destination channels. Startup checks all applied
migration checksums and stops if an upgrade is missing. It never migrates implicitly.

The original table format stores XP **within the current level**. The total
threshold for level L is `1500 * L * (L + 1)`. Some legacy `/set` operations may
have stored lifetime XP in that residual column. `db:check` reports noncanonical
rows; the rewrite refuses to guess their intended values. Repair a member with
`/level set` using a verified lifetime XP value.

## Move old Supabase data to Aiven

Changing `DATABASE_URL` does not transfer any rows. The old Supabase connection
currently needs repair, or you need an existing export. Until one is available,
the old data cannot be migrated or verified. Keep the old project and any backups.

Once access is restored:

1. Stop all writers to the old database for a consistent transfer.
2. Export only the old `discord` schema's **table data** with PostgreSQL's
   `pg_dump --data-only --schema=discord --no-owner --no-privileges`. Use a
   PostgreSQL client at least as new as the source server. Store credentials in
   your local PostgreSQL connection configuration, not in committed scripts.
3. Initialize an empty Aiven database with `db:init --apply`.
4. Restore the data-only SQL with `psql --set ON_ERROR_STOP=on --single-transaction`.
   Do this before starting Caretaker, so tables are still empty. The original
   `pg_dump` includes explicit columns, so newly added columns use their defaults.
5. Compare per-table counts and important member records against the source,
   run `db:check`, then smoke-test one server before switching permanently.

This route avoids copying Supabase's `auth.uid()` policies and built-in roles
to Aiven. Preserve the application ID and encryption key. The portable baseline
includes legacy balances, account links and verification-token tables even
though their feature plugins are not implemented. If the source schema differs
from the checked-in legacy schema, review the differences before importing.

A full-project Supabase dump is not a drop-in import for Aiven. Do not run the
original schema file's suggested `DROP SCHEMA` operation. Keep exports private:
they contain member IDs, birthdays and encrypted credentials.

## Recovery and operating notes

Serialized JSON parameters must use `$n::text::jsonb`, not `$n::jsonb`:
postgres.js otherwise serializes an already-stringified value again. Settings
reads defensively recover legacy JSON strings and expanded character keys.
Malformed values fail without replacing the stored data with defaults.

For affected installations, stop the bot, preview with
`bun scripts/repair-settings-json.ts`, then run it with `--apply`. It validates
the recovered settings and saves their originals under `backups/settings-json-*`
before updating anything. Only this application's rows are repaired, and all
updates share a transaction. The latest named fields take precedence over
older embedded values. Keep the backup if older settings need manual review.

The regular test suite uses PGlite. To also test postgres.js serialization over
a real PostgreSQL connection, set `TEST_POSTGRES_JSON=1` and run
`bun test tests/postgres-json.integration.test.ts` from the configured project.
This opt-in test uses temporary tables that are dropped at the end; it does not
change server settings or member records.

- The runtime lease is renewed every 30 seconds and expires after 120 seconds.
  Do not run multiple replicas for one bot ID. A lost lease triggers shutdown.
- Cleanup schedules query PostgreSQL even while Discord is quiet. This is an
  always-running bot design; it is not optimized for Neon's compute-hour quota.
- New ticket activity timestamps start at migration time, giving old tickets a
  fresh inactivity window. New message XP cooldown timestamps start empty.
- PostgreSQL transactions protect database writes. Discord actions and database
  commits cannot form one transaction; see the feature caveats in UPGRADE.md.
- For local PostgreSQL only, `DATABASE_SSL=disable` is available. Aiven needs TLS.
- Supabase's bundled public CA is selected only for Supabase hostnames when no
  custom CA is configured. Other providers use the system trust store or your
  explicit `DATABASE_CA_FILE`.
