#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .tmp
fixture=$(mktemp -d .tmp/proxy-config.XXXXXX)
trap 'rm -rf "$fixture"' EXIT HUP INT TERM
cat > "$fixture/env" <<'CONFIG'
SERVER_IMAGE=ultra-tasks-server:config-validation
DOMAIN=app.example.test
PUBLIC_URL=https://app.example.test
POSTGRES_PASSWORD=isolated-config-fixture
ULTRA_SERVER_ID=3e2edea8-ff50-4f20-87f6-a8f0465f9945
ULTRA_OPAQUE_SETUP=isolated-config-fixture
ULTRA_AUTH_SECRET=isolated-config-fixture-secret-at-least-32-characters
ULTRA_EXTERNAL_PROXY=true
ULTRA_HTTP_PORT=13110
SMTP_HOST=smtp.example.test
SMTP_FROM=account@example.test
CONFIG
ULTRA_ENV_FILE="$fixture/env" sh scripts/compose.sh --profile '*' config --format json > "$fixture/config.json"
node - "$fixture/config.json" <<'CHECK'
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const server = config.services.server;
assert.equal(server.environment.ULTRA_AUTH_ENGINE, 'better-auth');
assert.equal(server.ports.length, 1);
assert.equal(server.ports[0].host_ip, '127.0.0.1');
assert.equal(String(server.ports[0].published), '13110');
assert.equal(server.ports[0].target, 1900);
assert.equal(config.services.postgres.ports, undefined);
assert.deepEqual(config.services.caddy.profiles, ['standalone-https']);
console.log('External proxy config passed: Better Auth, loopback app port, private database, opt-in Caddy.');
CHECK
