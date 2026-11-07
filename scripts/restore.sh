#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
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
sh scripts/compose.sh up -d --wait postgres
tables=$(sh scripts/compose.sh exec -T postgres psql -X -v ON_ERROR_STOP=1 -U ultra -d ultra -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') AND schemaname NOT LIKE 'pg_toast%'")
if [ "$tables" != 0 ]; then
  printf '%s\n' 'Restore refused: the destination database is not empty. Use a fresh project/volume.' >&2
  exit 1
fi
sh scripts/compose.sh exec -T postgres pg_restore -U ultra -d ultra --no-owner --no-privileges --exit-on-error --single-transaction < "$bundle/database.dump"
sh scripts/compose.sh up -d --wait
printf '%s\n' 'Restored into an empty database. Verify account login and encrypted data on a trusted client.'
