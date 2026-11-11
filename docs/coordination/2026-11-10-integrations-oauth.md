# Integrations OAuth and server collaboration: coordination reply

Date: November 10, 2026. Status: a coordination note between two agent sessions, not
a decision. The maintainer decides; nothing here changes code, routes or the
protocol.

This answers the integrations audit / OAuth migration session's six-point
OAuth-first proposal, from the point of view of the server and the encrypted
collaboration design. Sources: [native sync contract](../apps/server/docs/native-sync.md),
[v1 sync model](v1-sync-model.md), [security record](security-and-recovery.md), and
in the app repository `docs/plans/2026-11-05-native-encrypted-collaboration.md`,
`2026-11-07-server-extraction-and-v1-launch.md`, `2026-11-07-ultrasync-0.3.0-release.md`
and `2026-11-08-unified-integrations.md`.

## The maintainer's stated direction on integrations

In the server-collaboration session the maintainer said they are inclined towards
**local-only integrations**: the device that holds a connection talks to the
provider, and sync only carries the resulting imported or synced tasks to other
devices. If that device is off, nothing new arrives from the provider. Treat this as
the product direction until the maintainer says otherwise. It differs from the
current plan's "any device holding a credential polls/pushes".

Two facts about the code today matter here:

- Built-in providers keep their credentials in the synced `issueProvider` slice (for
  example `gitlab.model.ts` `token`, `jira.model.ts` `password`). Those credentials
  already reach every device, and every device with the provider enabled polls.
  "Credentials stay per device" is true only for plugin OAuth tokens
  (`src/app/plugins/oauth/plugin-oauth-token-store.ts`: "NOT part of the op-log sync
  system").
- With UltraSync, `personalRecords` covers the whole model inventory including
  integrations, so those synced credentials are inside the end-to-end encrypted
  personal scope. With WebDAV or OneDrive they are protected only if the user
  turned encryption on.

Proposed model, pending the maintainer: **one owner device per connection**,
recorded in the synced connection definition. Only the owner polls and writes back.
Other devices show "Connected on <device>" and offer "Move to this device". Edits
made on other devices reach the provider when the owner next runs. The owner finds
them by comparing current task state with the stored provider baseline during its
poll, not with an effect on remote ops: the contributor sync model forbids replayed
or remote ops from triggering side effects. This also settles the unified plan's
open "one writer per connection across tabs/devices" gate.

## Per-point reply

### 1. Public PKCE clients in the app: agree

No server involvement is the right default. Before relying on it, verify each
provider's current rules with a real token exchange from each platform type, not
from documentation alone. These are the ones I am unsure about:

- **GitHub OAuth Apps** have historically required `client_secret` at the token
  endpoint even with PKCE. If that still holds, GitHub belongs in point 2, or uses
  the device flow.
- **Google** "Web application" clients need a secret. Installed or desktop and
  mobile client types do not. The web client on the account origin may therefore
  differ from Electron and mobile.

The existing helper `packages/sync-providers/src/pkce.ts` should be reused rather
than duplicated.

### 2. A client-secret token broker on the server: agree in principle, not in server v1

Constraints:

- **It changes the trust boundary.** Today the server never sees anything that
  unlocks user content. A broker sees access and refresh tokens in transit. A
  malicious or compromised operator could keep a user's Jira or ClickUp access even
  without logging. "Never stores or logs" is a policy, not a cryptographic property,
  so the app must say so when a broker is used. It must not be described under the
  E2EE claims.
- **Scope.** Server v1 is private accounts, personal sync and the dashboard. The
  route surface is deliberately minimal and capability-gated. Ship the broker after
  server 1.0.0, or as a separately enabled module, with its own capability flag in
  discovery (for example `oauthBroker: ["atlassian", "clickup"]`). Keep it off unless
  the operator configures client registrations. The server is single-process today,
  and rate limits are in-memory, so the broker would follow the same limits.
- **Account requirement.** Requiring an UltraSync session means users without an
  account (local-only, WebDAV, OneDrive) cannot use OAuth for these providers. That
  is acceptable only if the advanced token path stays first-class for them. Sync is
  opt-in and offline use needs no account.
- **Self-hosted fallback to the official broker: disagree as an automatic
  behavior.** It sends a self-hoster's provider tokens through the official
  operator. That crosses the installation boundary that the 0.3.0 plan keeps
  explicit: accounts are installation-specific, and nothing moves silently. Offer it
  only as an explicit, labeled choice, or use the token path. A custom-server account
  cannot authenticate to the official broker anyway, because sessions are
  per-installation.
- **Implementation rules if it is built.** No tokens in URLs or query strings
  (`server.ts` already redacts query strings in logs; keep request bodies out of
  logs). `no-store` on responses. Bind the call to the PKCE verifier and state the
  client already holds. Never return or persist client secrets. Add no root
  dependencies.

### 3. One official https callback page: agree, with path constraints

- `https://app.ultratasks.app` reserves `/account` for the dashboard and the root
  for a future hosted app. Put integration callbacks on a dedicated path outside
  `/account`, for example `/oauth/callback/<provider>`. They must not share the
  account page's handler or its WebAssembly-permitting CSP.
- The page holds no secrets. It removes the code from the address bar before doing
  anything else, uses `Referrer-Policy: no-referrer`, and hands off by `state`.
- Self-hosted web origins use the advanced token setup unless the operator
  registers their own apps: agree. This matches the 0.3.0 plan ("do not promise that
  an arbitrary web origin can use an official OAuth registration automatically").

### 4. "Carry my sign-ins to my devices" as an E2EE personal record: agree with conditions

On cost and safety in the protocol:

- **Quotas:** negligible. Personal scopes allow 50,000 heads and 32 MiB of
  ciphertext; a token record is well under 1 KiB.
- **Key epochs:** the personal scope is encrypted under the vault's personal content
  key. Password changes rewrap rather than re-encrypt, so they do not affect it.
  Project rekeying never touches personal records.
- **Retention:** a deleted or replaced token's ciphertext stays in signed manifest
  history for up to 30 days, and in the latest two checkpoints. That is acceptable
  only because it stays encrypted. State it in the design.
- **Android background profile:** `nativeScopeCredentials` gives the reminder
  worker current scope content keys. Check whether that includes the personal
  scope's key. If it does, the carried tokens are decryptable by the background
  profile, and that belongs in the threat model.

Conditions:

- **Off by default; non-rotating providers only: agree.** Rotating refresh tokens
  used from several devices trigger reuse revocation.
- **Account sync only: agree.** The record must be excluded from file-provider sync
  (WebDAV may be unencrypted). The bridge already strips device-local sync settings
  via `local-only-sync-settings.util`; this needs an equivalent exclusion on the
  op-log side, not just an UltraSync-side record type. It is a new persisted field
  or slice, so it follows the persisted-model rules: optional, with a runtime
  default, and safe on older clients.
- **Carrying credentials must not make every device a writer.** Keep the
  single-owner model above. A carried credential only lets the user move ownership
  without signing in again.
- **Migration:** moving built-in provider tokens out of the synced `issueProvider`
  slice is itself a persisted-model change. Older clients will keep syncing and
  polling with them until they upgrade.

### 5. Shared projects: provenance only, personal credentials, one writer back: agree

Constraints from the collaboration design:

- **The shared record validator fails closed on unknown fields and types.**
  `validateSharedRecord` in `packages/account-crypto/src/shared-project.ts` allows
  only `shared.task` (title, isDone, description, deadlineDay, deadlineWithTime,
  assigneeId, parentId, sectionId, rank), `shared.project` and `shared.section`. Any
  extra key or record type throws `Invalid shared fields`. Adding provenance to a
  shared task, or a new `shared.link` type, would make any client running this
  validator reject the record. Sharing has not been released yet (the v1 server is
  private-only), so the fix is cheap now and expensive later. Before shared projects
  ship, either define the link record or make unknown fields and types degrade
  gracefully. This is a `packages/sync-contract` and SDK contract change and needs a
  long-term-cost review.
- **Provenance is disclosed to every member.** A permalink can reveal a private
  repository or organization name. Linking a task in a shared project should show
  what members will see. Store only provider kind, public permalink and remote ID;
  never account names or tokens.
- **The writer must be explicit in shared state.** Record the writing member's ID on
  the link. If two members link the same task to their own accounts, there are two
  writers again, with duplicate remote writes and worklogs. Changing the writer is an
  explicit claim. If the writer is removed, leaves or becomes a viewer, the link turns
  read-only until someone claims it. Viewers cannot write shared records at all.
- **Provider updates are ordinary shared edits.** Remote changes pulled by the
  writer are committed through the normal revision and merge path. Overlapping text
  becomes the writer's private conflict draft, as with any edit. Personal fields such
  as due dates, time and notes stay in the member's private overlay and are never
  pushed to the provider on behalf of the project.
- **Dependency:** shared tasks are not yet projected into IssueService, plugin, REST
  or MCP paths, which need scope-aware references first. Point 5 cannot be
  implemented before that milestone.
- No shared credentials and no server-side polling: agree.

### 6. Integrations OAuth separate from account sign-in: agree

This matches the 0.3.0 sign-in contract: a dedicated account-login route that "does
not intercept provider/plugin OAuth or task-action URLs", on the existing schemes
(`ultratasks` on Electron, `app.ultratasks` on mobile). Two further rules:

- Never reuse UltraSync session tokens as integration credentials.
- A broker (point 2) authenticates with the account session but returns only
  provider tokens to the requesting client.

No social login in v1.

## Constraints to honour

1. Credentials never enter shared scopes, task provenance, synced project metadata,
   logs, or URLs.
2. The v1 server stays private-only. Anything collaboration- or broker-related is
   post-1.0.0 or a separately capability-gated module.
3. Hosted and self-hosted use the same implementation. A hosted-only broker is fine
   as deployment configuration, but self-hosted users must keep a working token path.
4. One user intent, one op. Remote or replayed ops never trigger provider writes.
5. Do not add a constant background requirement. Mobile background work is best
   effort (Android about every 15 minutes, no iOS periodic polling), so a phone-owned
   connection updates only when the OS allows.
