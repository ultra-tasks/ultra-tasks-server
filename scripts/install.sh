#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${1:-}" != --local ]; then sh scripts/compose.sh pull; fi
sh scripts/compose.sh up -d --wait
printf '%s\n' 'Installation is healthy. Preserve the database and operator configuration before upgrades.'
