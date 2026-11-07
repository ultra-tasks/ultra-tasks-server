#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
export ULTRA_DEVELOPMENT=true
base="ultra-installation-$$"
original="$base-source"
restored="$base-restored"
fixture=".tmp/restore-fixture-$$.json"
config=".tmp/installation-env-$$.env"
export ULTRA_ENV_FILE="$config"
legal="$(pwd)/.tmp/installation-legal-$$"
export ULTRA_LEGAL_DIRECTORY="$legal"
mkdir -p .tmp
mkdir "$legal"
printf '%s\n' '<!doctype html><title>Fixture privacy document</title><p>Isolated acceptance fixture only.</p>' > "$legal/privacy.html"
chmod 755 "$legal"
chmod 644 "$legal/privacy.html"
cleanup() {
  COMPOSE_PROJECT_NAME="$original" sh scripts/compose.sh down -v >/dev/null 2>&1 || true
  COMPOSE_PROJECT_NAME="$restored" sh scripts/compose.sh down -v >/dev/null 2>&1 || true
  rm -f "$fixture" "$config"
  rm -f "$legal/privacy.html" "$legal/terms.html"
  rmdir "$legal" 2>/dev/null || true
}
trap cleanup EXIT HUP INT TERM
export COMPOSE_PROJECT_NAME="$original"
docker run --rm --entrypoint node ultra-tasks-server:dev scripts/create-dev-env.cjs | sed 's/^ULTRA_REQUIRE_TERMS_CONSENT=false$/ULTRA_REQUIRE_TERMS_CONSENT=true/' > "$config"
sh scripts/compose.sh up -d --wait
test "$(sh scripts/compose.sh exec -T server wget -qO- http://localhost:1900/privacy.html)" = "$(cat "$legal/privacy.html")"
sh scripts/compose.sh exec -T server node scripts/smoke-dev.cjs --save-fixture
sh scripts/compose.sh exec -T server cat /tmp/ultra-restore-fixture.json > "$fixture"
node scripts/private-load.mjs < "$fixture"
printf '%s\n' 'Starting protected PostgreSQL backup'
backup=$(sh scripts/backup.sh | sed -n 's/^Backup bundle: //p')
test -n "$backup"
printf '%s\n' 'Backup completed; restoring into a fresh installation'
sh scripts/compose.sh down
rm "$legal/privacy.html"
export COMPOSE_PROJECT_NAME="$restored"
sh scripts/restore.sh "$backup"
cmp "$legal/privacy.html" "$backup/legal/privacy.html"
sh scripts/compose.sh exec -T server node scripts/smoke-dev.cjs --verify-fixture < "$fixture"
if sh scripts/restore.sh "$backup" > .tmp/restore-refusal.log 2>&1; then
  printf '%s\n' 'Restore incorrectly accepted a nonempty database' >&2
  exit 1
fi
grep -q 'destination database is not empty' .tmp/restore-refusal.log
sh scripts/compose.sh restart server
sh scripts/compose.sh up -d --wait
sh scripts/compose.sh exec -T server node scripts/smoke-dev.cjs --verify-fixture < "$fixture"
printf '%s\n' 'Fresh install, real PostgreSQL backup/restore, nonempty-database refusal, restart, and encrypted account recovery passed'
