#!/usr/bin/env bash
set -Eeuo pipefail

# Parse the whole function before updating this file from Git.
main() {
    local expected="${1:-}" force="${2:-}" target marker container state deadline
    if [[ $# -gt 2 || ( -n "$expected" && ! "$expected" =~ ^[0-9a-f]{40}$ ) || ( -n "$force" && "$force" != "--force" ) ]]; then
        echo "Usage: bash deploy/update.sh [validated-commit-sha] [--force]" >&2
        return 1
    fi
    cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
    for tool in git docker flock; do
        command -v "$tool" >/dev/null || { echo "Missing dependency: $tool" >&2; return 1; }
    done
    export GIT_TERMINAL_PROMPT=0
    export GIT_SSH_COMMAND="ssh -o BatchMode=yes -o StrictHostKeyChecking=yes"
    exec 9>"$(git rev-parse --git-path caretaker-update.lock)"
    flock -n 9 || { echo "Another deployment is running." >&2; return 1; }

    [[ "$(git branch --show-current)" == "main" ]] || { echo "Deploy from a main checkout." >&2; return 1; }
    [[ -z "$(git status --porcelain --untracked-files=no)" ]] || { echo "Tracked files have local changes; stopping." >&2; return 1; }
    [[ -f .env ]] || { echo "Create the server .env first." >&2; return 1; }
    docker compose version >/dev/null

    git fetch --no-tags origin refs/heads/main
    target="$(git rev-parse FETCH_HEAD)"
    if [[ -n "$expected" && "$expected" != "$target" ]]; then
        echo "Skipping superseded deployment; main no longer points to the validated commit."
        return 0
    fi
    # Never overwrite server edits or deploy a local commit that was not validated.
    git merge-base --is-ancestor HEAD "$target" || { echo "Local main has diverged; resolve it manually." >&2; return 1; }
    git merge --ff-only "$target"
    marker="$(git rev-parse --git-path caretaker-deployed-revision)"
    if [[ -f "$marker" && "$(cat "$marker")" == "$target" && "$force" != "--force" ]]; then
        echo "This commit is already deployed. Use an empty SHA and --force to redeploy."
        return 0
    fi

    # Both steps leave the current container running. Schema changes are manual.
    docker compose build bot
    docker compose run --rm --no-deps -T bot bun scripts/check-deployment.ts
    docker compose up -d --no-deps --no-build --force-recreate bot
    container="$(docker compose ps --all -q bot)"
    [[ -n "$container" && "$container" != *$'\n'* ]] || { echo "Expected one bot container." >&2; return 1; }

    # Running alone is insufficient: wait for this fresh container's ready log.
    deadline=$((SECONDS + 90))
    while ((SECONDS < deadline)); do
        state="$(docker inspect --format '{{.State.Status}} {{.RestartCount}}' "$container")"
        if [[ "$state" == "running 0" ]]; then
            if docker logs --tail 200 "$container" 2>&1 | grep 'Ready in ' >/dev/null; then
                printf '%s\n' "$target" > "$marker.tmp"
                mv -- "$marker.tmp" "$marker"
                echo "Caretaker deployed and reported ready: $target"
                return 0
            fi
        elif [[ "$state" != "created 0" ]]; then
            echo "Bot startup failed ($state). Inspect docker compose logs --tail=100 bot." >&2
            return 1
        fi
        sleep 2
    done
    echo "Bot did not report ready within 90 seconds. Inspect its logs; no automatic rollback was performed." >&2
    return 1
}

main "$@"
