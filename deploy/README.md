# Docker installation bundle

This bundle is under acceptance testing for the private-sync v1 server. The root README gives the local development command. Docker Engine with Compose is required; the application repository is not required to run a published image.

## Services

- PostgreSQL stores encrypted records, account authentication material, and sync metadata in `postgres-data`.
- `migrate` applies the tracked Prisma migration history once before the server starts.
- `server` runs as a non-root user and serves `/account`, the private v2 API, `/live`, and `/health`.
- Caddy terminates HTTPS and proxies the server. Its state is kept in separate volumes.
- The development overlay replaces public HTTPS with loopback port 1900 and adds a Mailpit inbox on loopback port 8025.

After startup, `sh scripts/smoke.sh` checks database readiness, dashboard delivery, actual SMTP verification mail, encrypted personal sync between two independent clients, and refusal of project sharing. It creates a disposable test account in this development database and refuses to run with production mail settings. CI runs it against a fresh PostgreSQL volume before image publishing.

Production starts with `docker compose --env-file deploy/.env -f deploy/compose.yaml up -d --wait` after setting a real domain, public HTTPS URL, SMTP delivery, and a tested immutable `SERVER_IMAGE` in `deploy/.env`. Use `env.example` as the variable reference. Generate persistent operator secrets once; do not regenerate them on upgrades. Caddy requires reachable ports 80 and 443. The database has no published host port.

Do not open the service to users yet: enrollment policy, operator privacy pages, real restore/load drills, native client cutover, and independent security review remain launch gates. Oracle, domain, and real SMTP configuration happen at the end of that process.

## Backup and updates

`sh scripts/backup.sh` writes a PostgreSQL custom-format dump to ignored `.tmp/backups`. Preserve the matching `deploy/.env` in a secure backup outside the machine: its server identity, OPAQUE setup, and authentication secret are required alongside database contents. A database dump by itself is insufficient. Protect dumps because authentication material and metadata remain sensitive even though task content is encrypted.

A documented, rehearsed restore into a fresh installation and automated update/rollback tooling are still required before v1. Until then, do not treat the presence of a backup script as proof of recoverability. Never use `down -v` on an installation whose data you want to keep.

Operators provide their own Docker host, storage, domain, and SMTP. Each installation is an independent service and identity domain. Accounts do not automatically transfer between servers.
