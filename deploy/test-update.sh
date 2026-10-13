#!/usr/bin/env bash
# Offline Linux regression checks: local Git repositories and a fake Docker CLI.
set -Eeuo pipefail
source_script="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/update.sh"
fixture="$(mktemp -d)"
trap 'rm -rf -- "$fixture"' EXIT
export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_AUTHOR_NAME=Test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=Test GIT_COMMITTER_EMAIL=test@example.invalid
export DOCKER_CALLS="$fixture/docker.calls" FAIL_PHASE=""
mkdir -p "$fixture/bin"
cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
    'compose build bot') [[ "$FAIL_PHASE" != build ]] ;;
    'compose run '*) [[ "$FAIL_PHASE" != preflight ]] ;;
    'compose ps --all -q bot') echo fake-container ;;
    'inspect '*)
        if [[ "$FAIL_PHASE" == startup ]]; then echo 'restarting 1'; else echo 'running 0'; fi ;;
    'logs '*) echo 'Ready in 1 server(s), 10 feature plugins loaded' ;;
esac
MOCK
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"
git init --bare --initial-branch=main "$fixture/origin" >/dev/null
git clone "$fixture/origin" "$fixture/author" >/dev/null 2>&1
mkdir -p "$fixture/author/deploy"
cp "$source_script" "$fixture/author/deploy/update.sh"
echo first > "$fixture/author/version"
git -C "$fixture/author" add .
git -C "$fixture/author" commit -qm first
git -C "$fixture/author" push -q origin main
git clone "$fixture/origin" "$fixture/server" >/dev/null 2>&1
touch "$fixture/server/.env"
cd "$fixture/server"
marker=.git/caretaker-deployed-revision

run_update() { bash deploy/update.sh "$@" > "$fixture/output" 2>&1; }
expect_failure() {
    if run_update "$@"; then echo 'Expected updater failure' >&2; exit 1; fi
}
assert_no_restart() { ! grep -q '^compose up ' "$DOCKER_CALLS"; }

sha1="$(git rev-parse HEAD)"
run_update "$sha1"
[[ "$(cat "$marker")" == "$sha1" ]]
: > "$DOCKER_CALLS"
run_update "$sha1"
! grep -q '^compose build ' "$DOCKER_CALLS"

# A dirty server checkout must not be overwritten.
echo local >> version
expect_failure "$sha1"
assert_no_restart
git restore version

# Publish another commit without a network service.
echo second > "$fixture/author/version"
git -C "$fixture/author" commit -qam second
git -C "$fixture/author" push -q origin main
sha2="$(git -C "$fixture/author" rev-parse HEAD)"
run_update "$sha1"
[[ "$(git rev-parse HEAD)" == "$sha1" ]]
assert_no_restart

for phase in build preflight; do
    export FAIL_PHASE="$phase"
    : > "$DOCKER_CALLS"
    expect_failure "$sha2"
    [[ "$(cat "$marker")" == "$sha1" ]]
    assert_no_restart
done
export FAIL_PHASE=startup
expect_failure "$sha2"
[[ "$(cat "$marker")" == "$sha1" ]]
export FAIL_PHASE=""
run_update "$sha2"
[[ "$(cat "$marker")" == "$sha2" ]]
: > "$DOCKER_CALLS"
run_update '' --force
grep -q '^compose up ' "$DOCKER_CALLS"

# A local commit must never be marked as the validated remote revision.
echo local > version
git commit -qam local
: > "$DOCKER_CALLS"
expect_failure "$sha2"
assert_no_restart
[[ "$(cat "$marker")" == "$sha2" ]]
echo 'Deployment regression checks passed.'
