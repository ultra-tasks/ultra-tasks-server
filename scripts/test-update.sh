#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
baseline=${1:?Usage: test-update.sh BASELINE_IMAGE CANDIDATE_SHA_IMAGE}
candidate=${2:?Provide the candidate immutable local image}
umask 077
export ULTRA_DEVELOPMENT=true
export COMPOSE_PROJECT_NAME="ultra-upgrade-$$"
config=".tmp/upgrade-env-$$.env"
fixture=".tmp/upgrade-fixture-$$.json"
export ULTRA_ENV_FILE="$config"
mkdir -p .tmp
cleanup() {
  sh scripts/compose.sh down -v >/dev/null 2>&1 || true
  rm -f "$config" "$fixture"
}
trap cleanup EXIT HUP INT TERM
docker run --rm --entrypoint node "$candidate" scripts/create-dev-env.cjs | awk -v image="$baseline" '/^SERVER_IMAGE=/ { print "SERVER_IMAGE=" image; next } { print }' > "$config"
sh scripts/compose.sh up -d --wait
# The old image runs this version's test fixture through stdin; no source is changed.
sh scripts/compose.sh exec -T server node - --save-fixture < apps/server/scripts/smoke-dev.cjs
sh scripts/compose.sh exec -T server cat /tmp/ultra-restore-fixture.json > "$fixture"
sh scripts/update.sh "$candidate" --local
sh scripts/compose.sh exec -T server node scripts/smoke-dev.cjs --verify-fixture < "$fixture"
printf '%s\n' 'Upgrade from the baseline image preserved account authentication and encrypted personal data'
