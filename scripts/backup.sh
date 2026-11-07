#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p .tmp/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target=".tmp/backups/database-$stamp.dump"
docker compose --env-file deploy/.env -f deploy/compose.yaml exec -T postgres pg_dump -U ultra -d ultra -Fc > "$target.tmp"
mv "$target.tmp" "$target"
printf '%s\n' "Database backup: $target" 'Preserve deploy/.env securely with this backup and copy both outside this machine.'
