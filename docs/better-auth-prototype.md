# Better Auth + OPAQUE compatibility prototype

Status: Opt-in prototype for the application 0.3.0 authentication decision. This is not a completed authentication migration or a production/security approval. Oracle deployment remains deferred.

## Run it

Use the normal installation and its existing persistent secrets. Apply migrations before starting the new build. Set `ULTRA_AUTH_ENGINE=better-auth` in the server environment or Compose `.env`; the runtime default is `native`. Unknown engine values stop startup.

The account website remains `/account`. Existing applications continue to use `/api/v2/accounts`; no client dependency change or new password prompt is needed. `/capabilities` reports `features.betterAuthSessions` for acceptance/diagnostics. Accounts, passwords, OPAQUE setup, and vaults belong to that installation for both official and custom servers.

## Ownership and compatibility

- Better Auth is pinned to 1.7.18 in the server workspace. No dependency is added to the application repository or server workspace root.
- The server's test workspace pins patched Vite 7.3.7. Better Auth's optional Vitest peer makes the existing test-tool chain participate in the production dependency audit; keeping the existing Vite major patched resolves the observed audit finding without a broader upgrade.
- The small `ultra-opaque-v2` Better Auth plugin runs the existing two-step OPAQUE login. It preserves `@serenity-kit/opaque` 1.1.0, immutable server/account identifier binding, and the current key-stretching profile. The community plugin cannot read this binding unchanged, so it is a design reference rather than a runtime dependency.
- Registration, email verification, MFA enrollment/verification, password changes, and recovery remain owned by the existing v2 account flow. Enrolled factors must complete before either a native or Better Auth session is issued. The stock Better Auth two-factor plugin is not installed and is not assumed to cover custom OPAQUE endpoints.
- In prototype mode, Better Auth creates and validates ten-minute opaque access sessions through its real bearer/session API. A narrow database adapter reads existing account identities without copying accounts. Only SHA-256 access-token digests and non-secret session fields are stored in the additive `ultra_better_auth_sessions` table.
- Existing device sessions remain the authority for account binding, revocation, idle/hard expiry, device listing, and rotating refresh receipts. Each refresh atomically replaces that device's Better Auth access session. There is at most one access row per persisted device session; native device-session expiry/deletion cascades to these rows. This bridge is deliberate prototype ownership, not a claim that Better Auth owns our full account lifecycle yet.
- Existing v2 JWT sessions remain accepted while the prototype is enabled. Successful refresh upgrades access issuance to Better Auth without changing account IDs. Turning the setting back to `native` rejects Better Auth access tokens; clients can refresh or sign in again. It does not change vaults or delete encrypted local/server data. Keep the additive migration installed during rollback.
- No generic Better Auth HTTP handler is exposed. Built-in plaintext-password registration, sign-in, reset, and set-password routes are absent. The Fastify routes retain request validation, rate limits, one-use challenges, and sanitized errors.
- The encrypted vault, password/recovery wraps, signing keys, personal sync records, generations, and signed transactions are unchanged. A framework session alone cannot decrypt them. Password changes/recovery still commit the new OPAQUE record and preserved vault/recovery material in the account transaction.

## Acceptance

Run the real SDK/SQL tests in both modes:

```sh
npm ci --ignore-scripts
npm run quiet -- db:generate
npm run quiet -- build
npm run quiet -- test
ULTRA_TEST_AUTH_ENGINE=better-auth npm run quiet -- test:native
ULTRA_TEST_AUTH_ENGINE=better-auth npm run quiet -- test:accounts:browser
# A disposable PostgreSQL database; the suite creates/drops its own random schema.
ULTRA_AUTH_TEST_DATABASE_URL=postgresql://test:test@localhost:5432/test \
npm run quiet -- test:better-auth:postgres
```

The dedicated `tests/better-auth.spec.ts` exercises existing native records/vaults, old JWT compatibility, hashed token storage, verification and MFA gates, access expiry, refresh/reuse revocation, password change/recovery, and one-use OPAQUE proofs. It uses real SDK cryptography, HTTP routes, Better Auth, and PGlite PostgreSQL SQL, without mocked authentication seams. Existing private-sync, realtime, recovery, and account-browser suites also run against the prototype engine in CI.

The screenshot acceptance uses the independently built real Angular client:

```sh
ULTRA_CLIENT_DIST=/absolute/path/to/client/.tmp/angular-dist/browser \
ULTRA_AUTH_SCREENSHOTS=/absolute/path/to/output \
npm run quiet -- test:better-auth:browser
```

Set `CHROMIUM_BIN` for an existing isolated Chromium installation if Playwright's default browser is absent. Optionally set `ULTRA_ELECTRON_EXECUTABLE` to the Ultra Tasks executable to exercise the actual Windows desktop shell using its custom URL and a separate test profile. For a development Electron binary, also set `ULTRA_ELECTRON_APP` to the application checkout after `npm run quiet -- electron:build`. Keep the shell/preload and frontend builds matched. Without the executable, app captures use the browser build and must be labeled accordingly. All accounts, authenticators, emails, and screenshots in these tests are synthetic. The website presents MFA as a focused step with a Back to sign in action that clears pending client credentials.

## Remaining adoption decisions

Before selecting this for 0.3.0, assess whether the session adapter and compatibility bridge reduce total maintenance enough to justify adoption. The prototype intentionally does not migrate MFA/account recovery to Better Auth, adopt the community plugin's different record format, replace vault password wrapping with an OPAQUE export key, or introduce passkey PRF vault unlock.

Full browser sign-in with encrypted key handoff and automatic return to an app that has not entered its password remains a separate contract. Existing browser approval is still WebAuthn MFA after app password login. The existing app UI still needs the planned UltraSync provider/copy update for 0.3.0. Physical-device iOS/Android/macOS acceptance, full HTTP concurrency and deployed upgrade acceptance for the enabled prototype, and independent security review remain release gates. The focused PostgreSQL lock test below does not establish those broader results.

## Review

Fresh-context code review found one concrete issue: a redundant account foreign key acquired an account key-share lock after refresh held its session, reversing the lock order of account security changes. Fixed by keeping account deletion cascading through the existing device-session foreign key. No other concrete correctness finding remained in that review; this was not an independent cryptographic audit.

The permanent PostgreSQL 16 regression uses real Prisma connections, OPAQUE/vault fixtures, and Better Auth issuance. Its negative control restores the redundant constraint and proves `40P01`. The corrected race completes, rotates the refresh receipt, rejects access after revocation, and cascades account deletion. The review's route-coverage gap was also fixed with a native-refresh → Better Auth → native-rollback acceptance test that preserves vault keys.

Validation on November 7, 2026:

| Check                                                                               | Result                                                                                         |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| SDK cryptography/HTTP                                                               | 15 tests passed                                                                                |
| Native account/sync/realtime/recovery with Better Auth enabled                      | 48 tests passed                                                                                |
| Linux server regression, Node 24                                                    | 1,490 tests passed; 48 inherited PostgreSQL-dependent tests skipped, not counted as validation |
| Dedicated PostgreSQL 16 lock-order regression                                       | 2 tests passed, including the failing-design negative control                                  |
| Account website, including virtual WebAuthn MFA, recovery, offline unlock, deletion | 3 tests passed                                                                                 |
| Two real Angular clients, automatic private sync/offline/concurrent edits           | 1 test passed                                                                                  |
| Website and rebuilt Windows Electron sign-in/MFA/linking, with screenshots          | 2 tests passed                                                                                 |
| Compiled Node 24 runtime, package/server build, dashboard typecheck, file checks    | Passed                                                                                         |
| Production dependency audit                                                         | Zero vulnerabilities                                                                           |

Screenshots exercise the local prototype with synthetic data, not a deployed official service. The focused PostgreSQL regression exercises the real adapter/issuance transaction; it is not full HTTP concurrency or upgrade acceptance.
