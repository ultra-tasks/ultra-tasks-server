# Ultra Tasks server

The self-hostable account and end-to-end encrypted sync backend for Ultra Tasks. This is a pre-release extraction, not a production-ready 1.0.0 release. The v1 scope is private account sync and an account dashboard; project sharing and the full browser task application are deferred. Oracle deployment is the final phase.

## Development

Use Node.js 24 and Docker Engine with Compose.

```sh
npm ci --ignore-scripts
npm run db:generate
npm run quiet -- build
npm run quiet -- test
```

Server source and migrations are in apps/server, the browser account entry is in apps/account, and the framework-independent SDK is in packages/account-crypto. Root scripts build dependencies in order. The production image does not require the Angular/Electron repository. See [source provenance](SOURCE.md) and [implementation status](docs/implementation-status.md).

## Docker

Build and start the local installation with development email delivery:

```sh
docker build -f apps/server/Dockerfile -t ultra-tasks-server:dev .
sh scripts/dev.sh
```

Open http://localhost:1900/account and http://localhost:8025 for development email. The script generates persistent development secrets in ignored `deploy/.env` with restrictive permissions. Keep that file across restarts. Do not use its localhost URLs or Mailpit settings for a public installation.

The new entry point exposes only accounts, personal sync with authenticated wakeup notifications, and the dashboard. It omits legacy authentication, legacy sync, project sharing, and shared realtime. The installation bundle and setup/update/backup/restore commands are in [deploy](deploy/README.md); inherited Compose/Helm/deployment files under apps/server are historical references, not the supported v1 installation. Production enrollment defaults to closed.

After checks and native AMD64/ARM64 lifecycle acceptance pass on `main`, CI publishes a development image tagged `ghcr.io/ultra-tasks/ultra-tasks-server:sha-<full-commit>`. Verify the workflow and registry access before using a tag. The container package is public and can be pulled anonymously; source builds and dependency artifacts also need no private credentials. There is no stable 1.0.0 image yet.

## Validation

`npm test` runs the account SDK and native account/sync/realtime/recovery suites. `npm run test:server` runs the inherited server regression suite. Browser and real PostgreSQL checks are separate. The browser client integration requires `ULTRA_CLIENT_DIST` pointing to an independently built Ultra Tasks browser bundle.

`ULTRA_LOAD_QUOTA=true sh scripts/test-installation.sh` exercises real PostgreSQL, personal realtime, concurrent devices, quota preservation, paired backup/restore, and restart. `scripts/test-update.sh` exercises an actual image upgrade. See [security and recovery evidence](docs/security-and-recovery.md) for the remaining stable-release gates.

For checks, use `npm run quiet -- <script>`; logs are written to .tmp/logs. `checkFile` checks formatting; server/package TypeScript builds and tests provide the owner checks for files ignored by the client repository's Angular ESLint configuration.
