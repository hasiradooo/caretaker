# Automatic Linux deployment from GitHub

Push or merge into `main` → the **Check** workflow passes → **Deploy** connects
through SSH → the server fetches that exact commit, builds the image, checks the
database, and recreates the bot. No polling job or public webhook endpoint is needed.
Deployment starts disabled. These files must be committed and merged into `main`
before the setup below works. The existing Windows checkout may stay on `beta`.

## 1. Prepare the Linux server

Install Git, Bash, `flock` (usually supplied by util-linux), OpenSSH server, and
[Docker Engine with the Compose plugin](https://docs.docker.com/engine/install/).
Enable Docker at boot. Use a dedicated Linux deployment account with a home
directory and permission to run Docker without sudo. Docker access is effectively
root access, so keep this account and its SSH key dedicated to deployment.
The host's SSH port must be reachable from the GitHub runner.

Log in as that deployment account and clone into its home directory:

```sh
git clone --branch main --single-branch https://github.com/hasiradooo/caretaker.git "$HOME/caretaker"
cd "$HOME/caretaker"
docker compose version
docker info >/dev/null
```

If the repository is private, use a separate read-only GitHub deploy key on the
server and clone with `git@github.com:hasiradooo/caretaker.git` instead. Verify
GitHub's SSH host key against its published fingerprints before accepting it.
The server must be able to fetch without a password or interactive prompt.
This server-to-GitHub key is separate from the Actions-to-server key below.

Transfer your existing `.env` and Aiven CA securely to this checkout. Keep the
same Discord token and encryption key, and keep `DATABASE_CA_FILE` relative,
for example `certs/aiven-ca.pem`. This certificate filename is ignored by Git.
Do not edit tracked source files on the server: the updater refuses local changes.
Keep secrets out of Git and Actions logs. Protect the environment file:

```sh
chmod 600 .env
```

## 2. Start once manually

Stop the old Windows bot instance first. Only one instance may hold the bot's
lease. From the Linux checkout:

```sh
bash deploy/update.sh
docker compose logs --tail=100 bot
```

The first command fetches current `main`, builds, performs a read-only migration
compatibility check, and starts the container. It waits up to 90 seconds for the
bot's ready log. This is a startup check, not continuous health monitoring.
Docker's restart policy handles crashes and reboots while Docker is enabled.

A missing migration stops deployment before replacing the running container.
Back up the database and follow [the database upgrade steps](DOCKER.md#upgrade-an-existing-database),
then rerun the updater. It never applies schema changes automatically.

## 3. Allow GitHub Actions to connect

On a trusted computer, create a dedicated key with an empty passphrase for this
unattended connection. Use a new filename; do not overwrite an existing key:

```sh
ssh-keygen -t ed25519 -f ./caretaker-actions -C caretaker-github-actions
```

Install the contents of `caretaker-actions.pub` in the deployment account's
`~/.ssh/authorized_keys` on the Linux server. A `restrict ` prefix on that key's
line disables forwarding and PTY access while still allowing this deployment
command. The directory must be mode 700 and `authorized_keys` mode 600.

In the repository, open **Settings → Secrets and variables → Actions** and add
these **repository secrets**:

| Secret | Value |
| --- | --- |
| `DEPLOY_HOST` | Linux server hostname or IP address |
| `DEPLOY_USER` | Dedicated Linux account that owns `$HOME/caretaker` |
| `DEPLOY_SSH_KEY` | Complete contents of the private `caretaker-actions` file |
| `DEPLOY_KNOWN_HOSTS` | Verified SSH known-hosts entry for this Linux server |

For `DEPLOY_KNOWN_HOSTS`, use the entry from a trusted SSH connection after checking
its fingerprint against the server console/provider. The entry starts with the
hostname (or `[hostname]:port` for a nonstandard port), followed by the key type
and public host key. The hostname must match `DEPLOY_HOST`. Do not blindly trust
an unverified `ssh-keyscan` result. The workflow requires strict host verification.

Under the **Variables** tab, add:

| Variable | Value |
| --- | --- |
| `DEPLOY_ENABLED` | `true` when the server and secrets are ready |
| `DEPLOY_PORT` | Optional SSH port; defaults to `22` |

Protect `main` with pull requests and passing checks; merged code runs with your
bot's credentials on this server. Anyone who can change deployment workflows or
use this SSH key can run commands as the deployment account.

## 4. Use it

Push or merge a change into `main`, then inspect **Actions → Check → Deploy**
(they are separate workflow runs). PR checks and pushes to `beta` never deploy.
Only successful push checks on this repository's `main` are accepted. An older
successful run is skipped if `main` has since moved, so it cannot deploy a newer,
unvalidated commit. Simultaneous deployments are locked on both GitHub and Linux.

To pause automatic updates, set `DEPLOY_ENABLED` to `false`. The bot keeps running.
To retry a failed deploy, rerun its Deploy job while the commit is still main's tip,
or run the manual updater on the server. A failed build or database check leaves
the old container running; a startup failure after replacement requires attention.
There is no automatic rollback. Use `docker compose logs --tail=100 bot` to diagnose.

After editing `.env`, or to restart the same deployed commit deliberately:

```sh
cd "$HOME/caretaker"
bash deploy/update.sh '' --force
```

The success marker lives in `.git/caretaker-deployed-revision` and is only written
after the bot reports ready. A retry still builds after a failed attempt, even if
Git already advanced. Never use `git reset --hard` to fix a deployment checkout
without reviewing and saving local changes first.

The updater does not deploy slash commands, change server settings, delete data,
or prune Docker images. Aiven remains your database; the Linux server runs the bot.

Reference: [GitHub workflow_run events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
