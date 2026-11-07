#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# Deliberately avoid compose config, environment dumps, and application logs.
docker version --format 'Docker server: {{.Server.Version}}'
docker compose version
sh scripts/compose.sh ps
sh scripts/compose.sh exec -T server node -e 'fetch("http://127.0.0.1:1900/health").then(async response => { console.log(JSON.stringify({revision:process.env.ULTRA_REVISION,node:process.version,healthStatus:response.status})); if(!response.ok) process.exitCode=1; }).catch(() => { console.error("Health request failed"); process.exitCode=1; })'
