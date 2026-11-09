# Encrypted Ultra Tasks accounts

New accounts receive an eight-digit email verification code. It is bound to the
account and expires 30 minutes after the registration is submitted. Requesting a
new code does not extend the registration deadline. Expired unverified accounts
are deleted, and the user must begin signup again. Codes are invalidated after
five incorrect attempts or a resend. Previously issued verification links remain
usable while an unverified registration is within its deadline. SMTP must be
configured to deliver verification emails.

The opt-in account foundation provides password registration and login, verified
email, optional usernames, TOTP and WebAuthn second factors, device sessions,
password changes, and client-side encrypted key vaults. The account portal is
available at `/account` when enabled. Existing SuperSync accounts and data remain
separate. The app can now explicitly migrate personal data and share native
projects through the [v2 encrypted scope protocol](native-sync.md). Capability
discovery reports `scopedSync`, `sharedProjects`, `sharedRealtime`, `scopeRecovery`,
and `browserMfa`. Personal sync is periodic; shared delivery uses near-real-time
notifications with HTTP fallback.

## Server setup

Build the workspace packages, apply Prisma migrations, and configure these values
before setting `ULTRA_ACCOUNTS_ENABLED=true`:

| Variable                | Purpose                                                                                                                               |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `ULTRA_SERVER_ID`       | Stable random UUID identifying this installation                                                                                      |
| `ULTRA_OPAQUE_SETUP`    | Persistent OPAQUE server setup generated once with the pinned package                                                                 |
| `ULTRA_AUTH_SECRET`     | Independent cryptographically random secret of at least 32 characters for sessions and encrypted authentication challenges/TOTP seeds |
| `PUBLIC_URL`            | Correct HTTPS origin; localhost HTTP is for development only                                                                          |
| Existing SMTP variables | Verification and recovery emails; no content or recovery keys are emailed                                                             |

Generate setup material on the operator's trusted machine with
`npx @serenity-kit/opaque@1.1.0 create-server-setup`. Generate the other secrets
with a cryptographically secure random generator. Keep them out of git and logs.
Back up the database and operator secrets together. Changing the server ID,
OPAQUE setup, or authentication secret is not an ordinary restart: it invalidates
identity contexts, password authentication, or stored authentication material.
Validate the configuration on a staging instance before enabling the feature.

`npm run account-crypto:build` builds the client library and browser portal. The
server build builds this dependency, and the server Dockerfile includes the new
workspace and generated portal. Normal server setup still requires
`npx prisma generate` and `prisma migrate deploy` against the configured database.
The new migration creates isolated tables; it does not rewrite legacy users.

## Recovery and security behavior

Account creation shows a random printable vault recovery key before finalizing
registration. Users must confirm that they saved it. The screen supports copying,
downloading a text file for a password manager, and printing. It warns that losing
both the password and recovery key, without an unlocked device, makes encrypted
data unrecoverable. The service never receives the recovery key or password.

A normal password change unwraps and rewraps the same account key on the client,
preserves the recovery key, and revokes other device sessions. Recovery requires
a one-use email link and a signature created with the recovery-unlocked private
key. If 2FA is enabled it also requires a TOTP code or one-use MFA recovery code.
WebAuthn-only accounts use an MFA recovery code for this recovery path. Email
access alone cannot replace the encrypted vault or decrypt its contents.

TOTP and WebAuthn are second factors after password proof. MFA enrollment supplies
ten single-use recovery codes; enabling another factor replaces the old set.
MFA codes recover authentication only, and do not decrypt the vault. TOTP seeds
are operator-encrypted; recovery codes, mail tokens, refresh tokens, and challenge
identifiers are stored as digests. OPAQUE state and enrollment challenges are
encrypted and expire. Attempt limits and per-route IP rate limits apply.

Access tokens last ten minutes. Refresh tokens rotate, have a 30-day inactivity
window and a 90-day absolute session limit, and revoke their session on reuse.
Sessions can be listed and revoked individually. Security changes require a
recent login. Legacy magic links/passkeys and legacy JWTs cannot authorize v2
account operations because the identities, routes, token audience, and sessions
are separate. Password-recovery and password-change publication atomically
replace credentials and wrappers, advance the vault version, and revoke sessions.

The portal removes email tokens from the address bar before API calls and uses
no-referrer/no-store response policies. Its CSP permits WebAssembly compilation
only on the account page, without permitting general eval or remote scripts.
Browser passwords, recovery keys, and unwrapped keys stay in memory; wrapped
offline vaults and encrypted refresh credentials remain in a separate IndexedDB
profile. Locking the page clears its in-memory account secrets, not the existing
application's plaintext task databases. Recovery files and printed keys are
plaintext secrets and need physical/password-manager protection.

## API and validation

Routes are mounted under `/api/v2/accounts`. The executable contract is
[routes.ts](../src/ultra-account/routes.ts); cryptographic envelope/schema contracts
live in [shared-schema](../../shared-schema/src/ultra-account-contract.ts).
Capability discovery, registration, verification, OPAQUE login, MFA completion,
session refresh/revocation, browser passkey approval, account deletion, profile,
password changes, and recovery are covered by
real-client tests using the shipped PostgreSQL migration with PGlite. No real
emails are sent during tests.

From the root, after building shared-schema and generating the Prisma client:

```sh
npm run quiet -- account-crypto:test
npm run quiet -- ultra-accounts:test
npm run quiet -- ultra-sync:test
npm run quiet -- ultra-realtime:test
npm run quiet -- ultra-recovery:test
npm run quiet -- ultra-realtime:load
npm run quiet -- ultra-sync:browser
npm run quiet -- ultra-accounts:browser
npm run quiet -- ultra-accounts:regression
npm run quiet -- ultra-accounts:build
```

The browser suite requires Chromium (`CHROMIUM_BIN`, default `/usr/bin/chromium`)
and loopback-listening permission. It runs real virtual-authenticator registration
and authentication, recovery-file download, password recovery with 2FA, and
offline cached unlock. It is separate from the default server suite; omitting it
does not validate browser/WebAuthn behavior. Existing PostgreSQL-dependent tests
still require their documented database setup.

Production PostgreSQL restore/load drills, physical-device performance, and an
independent security review remain release gates. The native contract documents
Android reminder scheduling and key-epoch handoff, iOS suspension limits, and
the dedicated shared-view differences. This implementation does not claim to solve
active malicious-client attacks, public-key directory transparency, or local
task database encryption.
