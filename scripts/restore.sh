#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
compose() { sh scripts/compose.sh "$@"; }
postgres_recovery() {
  compose exec -T -u postgres postgres sh -s -- "$1" < scripts/restore-postgres.sh
}
invalidate() {
  compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U ultra -d ultra < scripts/invalidate-restored-security.sql
}
restart_postgres() {
  compose restart postgres
  compose up -d --wait postgres
}

case "${1:-}" in
  --release)
    if [ "$#" -ne 2 ] || [ "$2" != --security-reconciled ]; then
      printf '%s\n' 'Release requires --security-reconciled. Follow the disaster recovery runbook.' >&2
      exit 1
    fi
    compose up -d --wait postgres
    phase=$(postgres_recovery phase)
    # Point-in-time recovery or reconciliation may have also copied auth artifacts.
    if [ "$phase" = locked ]; then invalidate; fi
    postgres_recovery release
    restart_postgres
    postgres_recovery clear
    printf '%s\n' 'Database released. Start and verify the server privately before restoring ingress.'
    exit 0
    ;;
esac
bundle=${1:?Usage: sh scripts/restore.sh BACKUP_DIRECTORY}
test -s "$bundle/database.dump"
test -s "$bundle/config.env"
umask 077
config=${ULTRA_ENV_FILE:-deploy/.env}
if [ ! -f "$config" ]; then cp "$bundle/config.env" "$config"; fi
if ! cmp -s "$config" "$bundle/config.env"; then
  printf '%s\n' 'Restore refused: use the matching backed-up operator configuration in a fresh installation.' >&2
  exit 1
fi
legal=${ULTRA_LEGAL_DIRECTORY:-deploy/legal}
mkdir -p "$legal"
chmod 755 "$legal"
for document in privacy.html terms.html; do
  if [ -f "$bundle/legal/$document" ]; then
    if [ -e "$legal/$document" ] && ! cmp -s "$legal/$document" "$bundle/legal/$document"; then
      printf '%s\n' 'Restore refused: an operator document differs from the backup.' >&2
      exit 1
    fi
    cp "$bundle/legal/$document" "$legal/$document"
    chmod 644 "$legal/$document"
  fi
done
compose up -d --wait postgres
tables=$(compose exec -T postgres psql -X -v ON_ERROR_STOP=1 -U ultra -d ultra -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'")
if [ "$tables" != 0 ]; then
  printf '%s\n' 'Restore refused: the destination database is not empty. Use a fresh project/volume.' >&2
  exit 1
fi
compose stop caddy server
postgres_recovery lock
restart_postgres
postgres_recovery check
compose exec -T postgres pg_restore -U ultra -d ultra --no-owner --no-privileges --exit-on-error --single-transaction < "$bundle/database.dump"
invalidate
printf '%s\n' 'Database restored in local-only recovery mode.' 'Reconcile account security and deletions before releasing the database. See deploy/README.md.'
