#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p .tmp/backups
stamp=$(date -u +%Y%m%dT%H%M%SZ)-$$
target=".tmp/backups/backup-$stamp"
mkdir "$target"
cp "${ULTRA_ENV_FILE:-deploy/.env}" "$target/config.env"
mkdir "$target/legal"
for document in privacy.html terms.html; do
  source="${ULTRA_LEGAL_DIRECTORY:-deploy/legal}/$document"
  if [ -f "$source" ]; then cp "$source" "$target/legal/$document"; fi
done
sh scripts/compose.sh exec -T postgres pg_dump -U ultra -d ultra -Fc > "$target/database.dump.tmp"
mv "$target/database.dump.tmp" "$target/database.dump"
printf '%s\n' "Backup bundle: $target" 'Contains database and operator secrets. Copy the protected bundle outside this machine.'
