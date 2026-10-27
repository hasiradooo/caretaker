# Run Caretaker with Docker

Use Docker Desktop with Linux containers on Windows, or Docker Engine with
the Compose plugin on Linux. Run the following commands from the Caretaker folder.
Docker runs the bot; your existing PostgreSQL database stays hosted by Aiven.

## Prepare once

Keep your existing `.env` and encryption key. For a new installation, copy
`.env.example` to `.env` and configure the bot and database first.

Keep the Aiven CA in `certs/`. Compose mounts this directory read-only at
`/app/certs`; use a container-relative path in `.env`, such as:

```dotenv
DATABASE_SSL=verify-full
DATABASE_CA_FILE=certs/ca.pem
```

The filename must match your downloaded certificate. If your file is named
`aiven-ca.pem`, keep `DATABASE_CA_FILE=certs/aiven-ca.pem`. A Windows path such
as `C:\...\ca.pem` is not available inside the Linux container.
Replacing the certificate requires a restart, not an image rebuild.

## Build and start

Stop any existing Caretaker process for this Discord application before starting
the container. Run one bot instance: the database lease rejects duplicate starts.

```sh
docker compose build
docker compose run --rm bot bun run db:check
docker compose up -d
docker compose logs --follow --tail=100 bot
```

Press Ctrl+C to stop following logs; the bot keeps running in the background.
If the database check reports missing migrations, follow the upgrade steps below
before starting. For an empty database, follow [database setup](DATABASE.md).
The container never initializes a database, applies migrations or deploys slash
commands automatically.

## Everyday commands

```sh
docker compose up -d --build    # Build changed code and start/recreate the bot
docker compose ps              # Show container status
docker compose logs --tail=100 bot
docker compose restart bot     # Restart the current image
docker compose down            # Stop and remove the container; Aiven data stays
```

After changing `.env`, run `docker compose up -d --force-recreate` so the
container receives the new values. Restart alone does not reload its environment.
The restart policy brings the bot back after a crash or Docker restart, unless
you stopped it. Docker itself must be running.

After pulling updated code, rebuild and recreate the bot:

```sh
git pull
docker compose up -d --build bot
docker compose logs --follow --tail=100 bot
```

Look for `Starting Caretaker v2.0.0+...` and the subsequent `Ready` message.
The build identifier changes when the running bundle or its dependencies change;
an ordinary restart keeps that identifier and gets a new startup time. The bot's
About Me shows the same **Caretaker build** and **Last start** (UTC). This works
without Git in the image and needs no new environment variables.

The checked-in GitHub Actions workflow runs checks; it does not deploy or restart
this container. Automatic deployment must be configured in your hosting service.

## Upgrade an existing database

Back up the database before applying migrations. The preview command explains
the operation without changing data; `--apply` performs the migration.

```sh
docker compose stop bot
docker compose build
docker compose run --rm bot bun run db:migrate
docker compose run --rm bot bun run db:migrate --apply
docker compose run --rm bot bun run db:check
docker compose up -d
```

The usual maintenance scripts work by replacing the container command, for example
`docker compose run --rm bot bun run commands:deploy` to preview slash commands.
The settings repair script writes backups; run that script locally as documented
in [DATABASE.md](DATABASE.md), or explicitly mount a writable backup directory.

## What the files do

- `Dockerfile` installs locked production dependencies, builds `dist/index.js`,
  and runs it as the non-root `bun` user. Source files remain available for
  maintenance scripts. Builds do not connect to Discord or PostgreSQL.
- `compose.yaml` loads `.env` at runtime, mounts certificates, handles restarts,
  and allows 30 seconds for graceful shutdown. It uses a read-only filesystem
  with writable temporary storage and limits stored logs to three 10 MB files.
- `.dockerignore` limits the build context to application files and the bundled
  public Supabase CA. Local credentials, backups and Aiven CAs are not in the image.

No database container or published ports are needed. The optional HTTP API is off
by default; see the commented port configuration in `compose.yaml` if you use it.
For readable local log times, set `LOG_TIMEZONE=Europe/Warsaw` in `.env`.

For a build without Compose, run `docker build --target runtime -t caretaker:local .`.
Compose is the recommended way to run the resulting image with its configuration.

References: [Bun Docker guide](https://bun.sh/guides/ecosystem/docker),
[Docker Compose services](https://docs.docker.com/reference/compose-file/services/).
