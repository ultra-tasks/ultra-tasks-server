# Server extraction status

Target: private account sync and the account dashboard for server 1.0.0. Current release: 0.1.0 development.

## Initial extraction

- Retained relevant source history and license notices.
- Separated the server and dashboard entry points into their own workspaces.
- Added independent dependency installation, build, and native test commands.
- Added a private-only production entry point and real encrypted two-device tests. Sharing and legacy endpoints are absent from that runtime.
- Moved browser account assets into their own build workspace. The existing dashboard supports signup, verification, login, recovery, second factors, and device sessions.
- Added a standalone multi-stage image, PostgreSQL/migration/server/Caddy Compose bundle, isolated development mail, secret generation, and a database backup command.
- Replaced upstream publishing workflows with checks and development images under `ultra-tasks/ultra-tasks-server`.
- Retained legacy dependencies and shared-project implementation for behavior comparison during extraction. These do not establish production readiness or the v1 public feature set.

## Next gates

1. Publish versioned shared packages and switch the client before removing its retained source snapshot.
2. Complete the dashboard navigation and website sign-in integration; the existing account/security forms are the foundation.
3. Validate native registration policy, personal realtime, and migration/write fencing.
4. Complete Docker install/update/backup/restore automation and image acceptance.
5. Pass real PostgreSQL concurrency/load/restore, supported-device checks, and independent security review.
6. Configure Oracle, domain, and SMTP last, then perform staging and limited beta before tagging 1.0.0.

The full maintainer plan is retained in the client repository at docs/plans/2026-11-07-server-extraction-and-v1-launch.md.

The current [sync model](v1-sync-model.md) distinguishes shipped behavior from the scheduling and migration work still required.
