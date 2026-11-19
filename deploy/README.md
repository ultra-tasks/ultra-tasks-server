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

Caddy handles HTTPS on reachable ports80/443. PostgreSQL has no published host port. The server runs as UID1001, so public legal documents need readable directories/files (755/644); secrets and backups remain private. CORS needs no entry for the web application served from this origin; list an origin only for a web application hosted elsewhere. Native accounts and personal sync are available; legacy endpoints and project sharing are absent from the production runtime.

### Existing HTTPS proxy

When the machine already hosts websites, set `ULTRA_EXTERNAL_PROXY=true` and an unused `ULTRA_HTTP_PORT` in `deploy/.env`. The normal install/update/diagnostic commands then use `compose.proxy.yaml`: Caddy stays disabled and only the application is exposed at `127.0.0.1:ULTRA_HTTP_PORT`. PostgreSQL remains private. Forward the selected HTTPS hostname to that loopback port using the existing proxy, including WebSocket upgrades, `Host`, `X-Forwarded-For`, and `X-Forwarded-Proto`. Preserve the existing sites and certificate manager. Keep `PUBLIC_URL` set to the public HTTPS origin.

The account dashboard uses `/account`, and the root of the same origin serves the web application once a bundle is installed (next section). Changing the WebAuthn origin later requires enrolling new passkeys, so choose that hostname before opening enrollment.

## Web application bundle

The server does not build or contain the web application. Each application release attaches `ultra-tasks-web-VERSION.tar.gz` and a `.sha256` file. Download both, then:

```sh
sh scripts/install-web.sh ultra-tasks-web-VERSION.tar.gz
```

The script verifies that the checksum file names that archive and matches it, rejects unsafe archive paths, unpacks into `deploy/web/VERSION/` (set `ULTRA_WEB_DIRECTORY` to move it), and switches `deploy/web/current`. To roll back, point `current` at an older version directory (`ln -sfn OLD_VERSION deploy/web/current`); no restart is needed. Hashed files from the previous release are carried forward for 30 days (`--keep-days`) and old version directories are pruned after that.

With the bundled Caddy, `deploy/Caddyfile` sends `/account`, `/api/`, `/live`, `/health`, `/privacy.html`, `/terms.html`, `/cal/` and the dashboard's own root files (`/ultra-account.css`, `/account-theme.css`, `/account-assets/`, `/simplewebauthn-browser.min.js`, `/ultra-account/`, `/ultra-account.html`) to the server and serves everything else from `current`. The dashboard page loads those root files, so a proxy that sends them to the web bundle leaves `/account` without styling or scripts. With no bundle installed, `/` still reaches the server and redirects to `/account`. The web application and the dashboard share an origin, so no CORS entry is needed; leave `CORS_ORIGINS` empty unless you host the web application on a different origin.

Behind an existing HTTPS proxy (`ULTRA_EXTERNAL_PROXY=true`), give that proxy the same split. This nginx fragment is illustrative; adapt paths and TLS to your host and keep the WebSocket upgrade headers:

```nginx
location ~ ^/(account(/|$)|account-assets/|account-theme\.css$|ultra-account(/|\.css$|\.html$)|simplewebauthn-browser\.min\.js$|api/|live$|health$|privacy\.html$|terms\.html$|cal/) {
    proxy_pass http://127.0.0.1:1900;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location /oauth/callback/ {
    root /srv/ultra-tasks/deploy/web/current;
    rewrite ^ /assets/oauth-callback.html break;
}
location / {
    root /srv/ultra-tasks/deploy/web/current;
    # The service worker scripts keep their names in every release, so they must be
    # revalidated, including safety-worker.js and worker-basic.min.js.
    location ~ ^/(index\.html|sw\.js|ngsw-worker\.js|safety-worker\.js|worker-basic\.min\.js|ngsw\.json|manifest\.json|assets/oauth-callback\.html)$ {
        add_header Cache-Control "no-cache";
    }
    # Only names carrying an 8-character content hash are immutable.
    location ~ "^/((main|chunk|polyfills|styles|worker)-[A-Za-z0-9_-]{8}\.(js|css)|media/.+)$" {
        add_header Cache-Control "public, max-age=31536000, immutable";
    }
}
```

The regular expression with `{8}` must be quoted in nginx. In `add_header`, a location that sets its own headers drops those set at the server level, so repeat any security headers there (or `include` a shared file).

Do not change the server ID or regenerate OPAQUE/authentication secrets during upgrades or hostname changes. Reusing an email on a new installation does not transfer encrypted data. Never use `down -v` for a database you intend to keep.

## Sign-in verification and session lifetime

Three settings in `deploy/.env` control how sessions behave. Details, the threat model and the failure matrix are in [account devices and sessions](../docs/account-devices-and-sessions.md).

| Variable                          | Default | Meaning                                                                                                                      |
| --------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ULTRA_DEVICE_EMAIL_VERIFICATION` | `true`  | A sign-in from a device the account does not recognise needs an emailed code. `false` is the kill switch. Needs working SMTP |
| `ULTRA_SESSION_IDLE_DAYS`         | `180`   | A session signs out after this many days without a refresh; every refresh renews it                                          |
| `ULTRA_SESSION_MAX_DAYS`          | `1095`  | Absolute session limit, fixed at sign-in; `0` removes it; not shorter than the idle days                                     |

New-device email verification is a second check on a password-only sign-in. It is **not** multi-factor authentication and it does not resist phishing. Enrolled authenticator or security-key factors always take precedence and are never replaced by email. Existing sessions keep syncing; the code is requested only when the password is used on a device with no valid device token.

**Staged rollout.** Applications older than the SDK that understands the code step cannot sign in on a new device while the setting is on; they are told to update and are never allowed through. For an installation with those applications in the field: apply the update with `ULTRA_DEVICE_EMAIL_VERIFICATION=false`, ship the applications, confirm a test account completes the code step, then set `true` and restart (`sh scripts/compose.sh up -d --wait`). To switch the check off in an emergency (for example an SMTP outage), set `false` and restart; pending codes simply expire. Setting the variable to anything other than `true` or `false` stops the server at startup.

The update adds a database migration (`20261118000000_account_devices_sessions`). It only adds columns and a table, so the paired backup taken by `scripts/update.sh` is the rollback point and a previous image continues to run against the migrated schema (it accepts only the older 43-character refresh tokens, so sessions that already hold a newer one sign in again). Device records hold a user-chosen device name and timestamps; no IP address or user agent is stored, and they are deleted with the account.

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

# Optional Turnstile registration protection

Create a Cloudflare Turnstile widget for the hostname in `PUBLIC_URL`. Set both
`ULTRA_TURNSTILE_SITE_KEY` and `ULTRA_TURNSTILE_SECRET_KEY` in the operator's
environment file. Keep the secret private. The server refuses to start with only
one key, and rejects registration if validation fails or the hostname differs.
Leave both values empty to use email verification and rate limits without
Turnstile on a self-hosted installation.
