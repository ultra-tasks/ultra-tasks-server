# Docker installation bundle

Docker Engine with Compose is required. A published image needs no source checkout, npm, or neighboring application repository. Each installation is an independent service and account identity domain.

## Production setup

Download the versioned Compose bundle, select its tested immutable image tag or digest, and pull the public GHCR image without authentication. Building from public source is also supported. Do not use an untested `latest` tag.

```sh
sh scripts/setup.sh https://accounts.example.com ghcr.io/ultra-tasks/ultra-tasks-server:sha-FULL_COMMIT
# Edit deploy/.env: configure real SMTP, domain, and public origin.
# Publish a privacy policy: set ULTRA_PRIVACY_URL to its HTTPS address, or provide
# deploy/legal/privacy.html (readable public file). terms.html is optional.
sh scripts/install.sh
sh scripts/diagnostics.sh
```

Setup refuses to replace an existing configuration. It generates the stable server UUID, OPAQUE setup, auth secret, and database password once, in a private `deploy/.env`. Enrollment defaults to closed. To open signup, publish the operator's privacy policy (an `ULTRA_PRIVACY_URL` address that `/privacy.html` redirects to, or a `privacy.html` file) and set `ULTRA_REGISTRATION_OPEN=true`; consent is required by default. Restart with `sh scripts/compose.sh up -d --wait`. The operator must supply accurate privacy/retention/contact information; the project does not invent legal claims for an installation.

Caddy handles HTTPS on reachable ports80/443. PostgreSQL has no published host port. The server runs as UID1001, so public legal documents need readable directories/files (755/644); secrets and backups remain private. CORS must list the actual trusted web-app origins. Native accounts and personal sync are available; legacy endpoints and project sharing are absent from the production runtime.

### Existing HTTPS proxy

When the machine already hosts websites, set `ULTRA_EXTERNAL_PROXY=true` and an unused `ULTRA_HTTP_PORT` in `deploy/.env`. The normal install/update/diagnostic commands then use `compose.proxy.yaml`: Caddy stays disabled and only the application is exposed at `127.0.0.1:ULTRA_HTTP_PORT`. PostgreSQL remains private. Forward the selected HTTPS hostname to that loopback port using the existing proxy, including WebSocket upgrades, `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`. Preserve the existing sites and certificate manager. Keep `PUBLIC_URL` set to the public HTTPS origin.

The account dashboard uses `/account`, leaving the root of the same origin available for a future hosted application. Changing the WebAuthn origin later requires enrolling new passkeys, so choose that hostname before opening enrollment.

Do not change the server ID or regenerate OPAQUE/authentication secrets during upgrades or hostname changes. Reusing an email on a new installation does not transfer encrypted data. Never use `down -v` for a database you intend to keep.

## Backup, restore, and upgrade

```sh
sh scripts/backup.sh
sh scripts/update.sh REGISTRY_IMAGE@sha256:FULL_DIGEST
# On a fresh, isolated installation, with the matching bundle:
sh scripts/restore.sh /secure/backup-directory
```

A backup bundle contains the full PostgreSQL custom-format dump, matching `config.env`, and operator privacy/terms pages. It includes authentication material and metadata as well as encrypted content. Protect the complete directory and copy it outside the machine. Preserve an independent encryption key if encrypting the off-machine backup.

Restore requires an empty database and refuses differing existing configuration/documents. It restores public documents with container-readable permissions, restores all database tables atomically, then starts the migration/server readiness chain. Verify login, recovery, and decrypted data with a trusted client before directing traffic to the restored service. The image named by the saved configuration must remain obtainable; preserve that image/digest alongside your retention policy.

Update accepts a full revision tag or digest. It pulls the candidate, stops public/app traffic, takes a paired backup, updates the configured image, then runs migrations and health checks. A failed update remains offline. Do not simply run an older binary against a changed schema: restore the pre-upgrade bundle into a fresh installation when rollback requires it, accounting for writes since the backup. `--local` is for already-built development images.

Diagnostics prints Docker/Compose versions, service state, image revision, Node version, and health status. It avoids environment dumps and application content. Host monitoring and off-machine backup scheduling are operator responsibilities; Oracle configuration is deferred until staging.

## Isolated acceptance

```sh
docker build -f apps/server/Dockerfile -t ultra-tasks-server:dev .
sh scripts/dev.sh
# Dashboard http://localhost:1900/account; development mail http://localhost:8025
sh scripts/smoke.sh
```

The development overlay uses loopback ports and Mailpit. Its generated persistent config must never be used for production. Stop this manual development stack before running lifecycle acceptance, since the tests also use loopback ports1900/8025.

`ULTRA_LOAD_QUOTA=true sh scripts/test-installation.sh` creates disposable projects/configuration/mail, verifies signup and encrypted sync, drives concurrent devices against real PostgreSQL, tests quota preservation, restores the paired bundle into a fresh volume, refuses a second restore into the nonempty database, and verifies restart/decryption. It also restores the privacy document with consent enabled. Only its own test volumes are removed. Aggregate measurements go to `.tmp/private-load.json`; credentials are never logged.

`sh scripts/test-update.sh BASELINE_IMAGE CANDIDATE_SHA_IMAGE` verifies that an existing account and encrypted data survive a real image upgrade. CI builds the initial private-server baseline from public source and runs both drills on native AMD64 and ARM64 before publishing a revision image. These checks do not substitute for a physical-device trial, independent crypto review, or an off-machine production recovery exercise.
