#!/bin/sh
set -eu

# Generic, name-agnostic Prisma migration deploy + recovery.
#
# Prisma 5.x wraps every migration in a transaction. PostgreSQL forbids
# CREATE/DROP INDEX CONCURRENTLY inside a transaction block, so such a
# migration fails with P3018 / SQLSTATE 25001 ("cannot run inside a
# transaction block"), and a later deploy then refuses with P3009 (the
# migration is stuck in a failed state).
#
# This script applies migrations and, ONLY for that specific failure mode,
# recovers by running the failing migration's own SQL out-of-band (no
# transaction), then marks it applied and retries. It hardcodes no migration
# names: the failing migration is read from Prisma's own output and its SQL is
# read from prisma/migrations/<name>/migration.sql.
#
# This script is COPYed into the image next to prisma/migrations in the same
# build, so it is always version-locked to the migrations it must handle. Both
# the host deploy.sh and the image startup CMD invoke it.
#
# Authoring rule for a CONCURRENTLY migration (so out-of-band re-runs are
# idempotent and a half-built INVALID index is cleared first):
#
#     DROP INDEX CONCURRENTLY IF EXISTS "x";
#     CREATE INDEX CONCURRENTLY "x" ON ...;
#
# Recovery supports CONCURRENTLY *index* migrations only. Statements must end
# with `;` at end of line, comments must be full-line `--`, and `;` must not
# appear inside string literals (true for all index DDL).

SCHEMA="prisma/schema.prisma"
MIGRATIONS_DIR="prisma/migrations"
MAX_ATTEMPTS="${MIGRATE_MAX_ATTEMPTS:-8}"

MIGRATE_LOG=""
MIGRATE_STATUS=0
LAST_RECOVERED=""

STMT_FILE="$(mktemp "${TMPDIR:-/tmp}/supersync-stmts.XXXXXX")"
cleanup() {
  rm -f "$STMT_FILE" "$MIGRATE_LOG"
}
trap cleanup EXIT

run_migrate_deploy() {
  MIGRATE_LOG="$(mktemp "${TMPDIR:-/tmp}/supersync-migrate.XXXXXX")"
  set +e
  npx prisma migrate deploy >"$MIGRATE_LOG" 2>&1
  MIGRATE_STATUS=$?
  set -e
  cat "$MIGRATE_LOG"
}

# Failing migration name, from Prisma's own output. Prefer the precise P3018
# "Migration name:" line; fall back to a backticked 14-digit-prefixed token
# (the "Applying migration `x`" line and the P3009 failed-migration sentence).
# Always exits 0 (used in `name=$(...)` under `set -e`); empty output = unknown.
parse_failing_migration() {
  name=$(sed -n 's/^Migration name: *\([^ ].*[^ ]\) *$/\1/p' "$MIGRATE_LOG" | tail -n1)
  if [ -z "$name" ]; then
    name=$(grep -oE '`[0-9]{14}_[A-Za-z0-9_]+`' "$MIGRATE_LOG" | tr -d '`' | tail -n1 || true)
  fi
  printf '%s' "$name"
}

log_has() {
  grep -q "$1" "$MIGRATE_LOG"
}

is_transaction_block_failure() {
  log_has 'P3018' && log_has 'cannot run inside a transaction block'
}

is_stuck_failed_migration() {
  log_has 'P3009'
}

migration_sql_path() {
  printf '%s/%s/migration.sql' "$MIGRATIONS_DIR" "$1"
}

# Guard: only ever touch a migration whose own SQL is a CONCURRENTLY index
# migration. A genuinely broken migration fails this and is never auto-resolved.
is_concurrently_index_migration() {
  sql="$1"
  [ -f "$sql" ] && grep -Eqi 'INDEX[[:space:]]+CONCURRENTLY' "$sql"
}

# One statement per line; multi-line statements collapsed to a single line
# (index DDL is whitespace-insensitive and has no line-spanning literals).
split_statements() {
  awk '
    /^[[:space:]]*--/ { next }
    {
      sub(/^[[:space:]]+/, ""); sub(/[[:space:]]+$/, "")
      if ($0 == "") next
      stmt = (stmt == "" ? $0 : stmt " " $0)
      if ($0 ~ /;$/) { print stmt; stmt = "" }
    }
    END { if (stmt != "") print stmt }
  ' "$1"
}

print_manual_recovery() {
  name="$1"
  sql="$2"
  echo ""
  echo "Manual recovery for $name:"
  echo "  npx prisma migrate resolve --rolled-back $name"
  split_statements "$sql" > "$STMT_FILE"
  while IFS= read -r stmt; do
    [ -n "$stmt" ] || continue
    echo "  printf '%s\\n' '$stmt' | npx prisma db execute --schema $SCHEMA --stdin"
  done < "$STMT_FILE"
  echo "  npx prisma migrate resolve --applied $name   # only after every statement above succeeds"
}

fail_loudly() {
  echo ""
  echo "ERROR: $1"
  echo "       This is not the CONCURRENTLY-in-transaction failure this script"
  echo "       recovers from. Investigate the migration; do not blindly mark it"
  echo "       applied. See https://pris.ly/d/migrate-resolve"
  exit "${2:-$MIGRATE_STATUS}"
}

recover_migration() {
  name="$1"
  sql="$2"

  echo ""
  echo "==> Recovering $name outside Prisma migrate (CONCURRENTLY cannot run in a transaction)..."

  set +e
  npx prisma migrate resolve --rolled-back "$name"
  resolve_status=$?
  set -e
  if [ "$resolve_status" -ne 0 ]; then
    echo "    Migration $name was not in a failed state; continuing with out-of-band SQL."
  fi

  split_statements "$sql" > "$STMT_FILE"
  exec_rc=0
  while IFS= read -r stmt; do
    [ -n "$stmt" ] || continue
    echo "    -> $stmt"
    if ! printf '%s\n' "$stmt" | npx prisma db execute --schema "$SCHEMA" --stdin; then
      exec_rc=1
      break
    fi
  done < "$STMT_FILE"
  if [ "$exec_rc" -ne 0 ]; then
    echo ""
    echo "ERROR: an out-of-band statement for $name failed."
    echo "       $name was NOT marked applied (schema may be incomplete)."
    print_manual_recovery "$name" "$sql"
    exit 1
  fi

  npx prisma migrate resolve --applied "$name"
  echo "    $name applied out-of-band and marked applied."
}

attempt=0
while :; do
  run_migrate_deploy
  if [ "$MIGRATE_STATUS" -eq 0 ]; then
    exit 0
  fi

  attempt=$((attempt + 1))
  if [ "$attempt" -ge "$MAX_ATTEMPTS" ]; then
    fail_loudly "prisma migrate deploy still failing after $attempt attempts."
  fi

  if ! is_transaction_block_failure && ! is_stuck_failed_migration; then
    fail_loudly "prisma migrate deploy failed (exit $MIGRATE_STATUS)."
  fi

  name="$(parse_failing_migration)"
  if [ -z "$name" ]; then
    fail_loudly "could not determine the failing migration from Prisma output."
  fi

  sql="$(migration_sql_path "$name")"
  if ! is_concurrently_index_migration "$sql"; then
    fail_loudly "$name is not a CONCURRENTLY index migration; refusing to auto-resolve."
  fi

  if [ "$name" = "$LAST_RECOVERED" ]; then
    echo ""
    echo "ERROR: $name failed again after out-of-band recovery."
    print_manual_recovery "$name" "$sql"
    exit 1
  fi

  recover_migration "$name" "$sql"
  LAST_RECOVERED="$name"
  echo ""
  echo "==> Retrying prisma migrate deploy after recovering $name..."
done
