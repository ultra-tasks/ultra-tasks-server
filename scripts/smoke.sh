#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
docker compose --env-file deploy/.env -f deploy/compose.yaml -f deploy/compose.dev.yaml exec -T server node scripts/smoke-dev.cjs
