# Private server v1 status

Target: private account sync and the account dashboard. This is a development release; server `1.0.0` has not been declared production ready. Oracle deployment is last.

## Implemented

- Independent server repository with 765 retained historical commits and license notices. The application no longer contains the server or SDK source.
- Published SDK `0.1.1` and native contract `0.1.0`. The application consumes exact release artifacts through its existing provider/schema packages. Frozen legacy compatibility artifacts replace duplicate source forks.
- Private production entry point: accounts, encrypted personal scopes, account dashboard, metadata notifications, and health endpoints. Sharing and legacy routes are absent; retained shared data is not deleted.
- Durable foreground capture after local edits, authorized personal wakeups, HTTP fallback, offline/reconnect/restart behavior, and explicit initial upload/download choices. No encrypted format, persisted task model, or protocol version change.
- Dashboard navigation, encrypted storage usage, profile, password/recovery/MFA, device revocation, and confirmed account deletion. Website links are enabled only when its public account origin is configured.
- Native enrollment policy and operator-provided privacy/terms pages. Production enrollment defaults to closed.
- Docker setup/install/update/backup/restore/diagnostics scripts, paired database/configuration/legal-document backups, fresh-database restore refusal, migration-before-readiness, bounded pools/resources, and log rotation.
- CI for native API/SDK/account browser checks, native AMD64/ARM64 PostgreSQL lifecycle acceptance, and revision-tagged images. Client CI owns the independently built Angular integration test.

## Acceptance evidence and limits

The maintained [security and recovery record](security-and-recovery.md) distinguishes automated checks from release gates. The client integration covers two independent Angular clients, automatic delivery, offline concurrent changes, and reopening encrypted state. The Docker capacity fixture uses independent account sessions and real PostgreSQL connections; it also verifies that quota refusal retains pending encrypted intents across reopening.

Capacity measurements are workload observations, not a hosted-user guarantee. Changed scopes still download consistent complete heads. Local client storage is not automatically encrypted by server E2EE. This release supports one application process; distributed notification/rate-limit/revocation coordination is future work.

## Remaining release gates

1. Run the final revision's AMD64/ARM64 CI and native desktop/mobile checks, then record published image digests. A workflow definition alone is not a pass.
2. Complete independent authentication/cryptography/browser review and physical-device acceptance, including suspension, credential storage, and reminders.
3. Verify the full migration inventory and retired-provider/device procedure on representative existing user data. Never silently merge an account with unrelated local data.
4. The container package is public; verify anonymous pulls and the final published-image acceptance results before selecting a release image.
5. Configure Oracle, HTTPS origin, SMTP, operator documents, off-machine backups, and actionable host monitoring. Enable the website/client account origin only after staging works.
6. Run a limited beta and an off-machine recovery/upgrade exercise before tagging stable `1.0.0`.

The maintainer plan is in the application repository, `docs/plans/2026-11-07-server-extraction-and-v1-launch.md`.
