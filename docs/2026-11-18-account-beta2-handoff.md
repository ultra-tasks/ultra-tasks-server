# Ultra Tasks account beta 2 server handoff

The maintainer requested investigation and documentation for later fixes on
November 18, 2026. This audit makes no server/runtime, schema or deployment change.

Canonical cross-repository audit in the sibling client checkout:
`../super-tasks/docs/plans/2026-11-18-account-beta2-audit-and-handoff.md`.
It contains confirmed reports, accepted decisions, source evidence, UI status
states, compatibility/security requirements and the next-beta acceptance matrix.

Server responsibilities:

1. Reuse the existing immutable `ultra_accounts.id` UUID and expose a copyable
   **Account ID** in the dashboard. The app will expose the same ID in settings.
   A support ID does not establish ownership or authorize support actions.
2. Remove username/display-name collection and profile controls. The canonical
   dashboard sources are `apps/account/public/` and `apps/account/src/portal.ts`;
   regenerate installed public/private assets with `npm run build:dashboard`.
   Do not manually edit installed copies under the server's public directories.
3. Keep legacy storage/API fields nullable/defaulted for compatible clients;
   update `packages/account-crypto` types/calls and check signed identity data
   before removing a wire field. Preserve IDs, vaults, sessions and existing data.
   Login and future invitation resolution currently share `accountByIdentifier`;
   do not add account-ID login when later adding email/ID invitations.
4. Rename current visible **UltraSync** copy to **Ultra Tasks account**, including
   dashboard and email/help copy. Keep stable API, crypto, package and storage
   identifiers and historical release names. Collaboration/invitations remain
   deferred; eventual invitations use email or server-scoped account ID.
5. Design default-on **new-device email verification**, with an authorized
   opt-out. The maintainer chose new/unrecognized devices, not every sign-in.
   Existing trusted sessions keep syncing. Enrolled TOTP/security keys take
   precedence and must never be bypassed by email.
6. Add secure device recognition, short-lived one-use bounded challenges and
   uniform native/browser approval enforcement. Do not trust client-provided
   device names/IDs as proof, reuse signup's one-day expiry, or claim email is
   equivalent to authenticator/security-key MFA. Specify revocation, expiry,
   SMTP failure behavior, resend limits and old-client upgrade/capability handling.
7. Coordinate initial-scope discovery and replacement safeguards with the client.
   The reported TestFlight missing-data case was confirmed as a missed source
   choice: “Account unlocked” preceded connecting existing personal data. Empty
   devices should download automatically; genuine two-sided choices must be
   prominent immediately after login. Discovery failure is not an empty account.
8. Audit responsive dashboard/security/device/recovery flows and support identity;
   keep privacy consent, recovery keys, plaintext calendar disclosures and
   destructive-action confirmations intact.

Baseline: source main `ffaaa50`; published/live beta.3 runtime `aabcb2b`.
Server and SDK release numbers remain independent of client `0.4.0-beta.2`.
Use the canonical audit for the compatibility, test and staged rollout gates.
Do not enable a new authentication requirement before compatible clients and
the account portal are ready; old clients must fail clearly rather than bypass it.

Relevant owners/tests: `apps/server/src/ultra-account/{routes,store,security,browser-login,browser-mfa,scope-routes}.ts`,
`apps/account/`, `packages/account-crypto/`, `scripts/install-dashboard.mjs`,
`apps/server/tests/ultra-accounts.spec.ts`, `ultra-accounts.browser.spec.ts`,
`better-auth.browser.spec.ts`, `browser-login.spec.ts` and SDK tests.
Run package checks, regenerate the dashboard, test real PostgreSQL and private
client flows, then installation/upgrade and published-image acceptance on both
AMD64 and ARM64. Back up and verify recovery before a future live rollout.

## Follow-up persistent sign-in report

The maintainer reported being asked to sign in after leaving desktop open
overnight with the computer sleeping and no account security changes. They
require persistent login and visible, actionable recovery if sync disconnects.

Read-only diagnosis on November 18 found all five recent server sessions still
valid and unrevoked. Their absolute/idle expiry dates were February 16, 2027 /
December 18, 2026; the current normal 90-day / 30-day policy did not expire them
overnight. No account contents or credentials were retrieved or changed.

Desktop lifecycle logs show app quit/restart at 00:42 local time before sleep;
the restart initiator is unknown. The client has no desktop vault/session restore
after restart: its sealed cached refresh credential still needs the in-memory
vault key. The “set up sync” reminder independently ignores native account state.
See canonical audit work package H for the full trace and acceptance scenarios.

For the next beta, coordinate OS-protected remembered credentials and renewable,
revocable trusted sessions with the SDK/client. Revisit hard lifetime limits so
ordinary idle/calendar age does not surprise users with a logout. Keep short-lived
access credentials, bounded refresh/device storage, revocation and recent-auth
requirements for sensitive account changes. Do not replace these with an immortal
access token or repeatedly replay a single-use refresh credential after failure.
Keep stronger MFA and new-device verification aligned with remembered-device
restoration. Existing-device resume must not send a new email every sync or wake.

Test advanced-clock renewal, sleep/wake/network transitions, update/relaunch,
keychain unavailable, terminal revocation and ambiguous lost refresh responses.
The last case is a coverage gap, not a demonstrated cause of this incident; no
session was found revoked and reuse detection must not be weakened speculatively.
