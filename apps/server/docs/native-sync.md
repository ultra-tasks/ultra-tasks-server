# Native encrypted scope sync

This opt-in v2 protocol implements periodic personal sync and native project
sharing. Enable the account service as described in [ultra-accounts.md](ultra-accounts.md).
In the app, open Sync settings → Native encrypted sync and sharing. Create and
verify an account at the server's `/account` page, save its recovery material,
then sign in with that same password. Existing legacy accounts are separate.

## Data ownership and scheduling

Each account has one personal scope. Each shared project has a separate scope,
content key, revisions, outbox, and download cursor. Personal records include
every persisted model: live tasks/projects, both archives, settings, planning,
tags, sections, reminders, time, integrations, metrics, and plugin documents.
Task/day/device time buckets retain positive accrual and explicit corrections;
work-context break counts/durations use the same mechanism. Entity membership
and references retain the legacy model shape inside personal documents.

Shared project records contain project/section titles, task titles, completion,
descriptions, hierarchy, order, deadlines, and assignee IDs. A strict client
allowlist rejects composed private task objects. Personal overlays hold planned
dates, scratch notes, personal reminders, and logged time. An overlay arriving before its project,
or surviving removal, remains personal data and can be exported. Descriptions
are excluded by default when copying a personal project; the source project and
its personal data remain intact. No integration credentials or historic time
are copied into a shared scope.

While unlocked, personal data syncs every 60 seconds, on reconnect/return to
the app, and through Sync now. Shared edits first commit to encrypted local
storage, then batch for 150 ms with a one-second maximum wait. Metadata-only
WebSocket notifications trigger verified HTTP catch-up. A five-second HTTP
fallback runs while active, and reconnect uses bounded exponential backoff.
Up to four project jobs run independently; local durable edits do not wait for
an in-flight download, and one stalled scope cannot block another. HTTP requests
have a 30-second bound. Scheduling includes no personal-content subscriptions; a shared edit or
notification never captures, applies, or uploads private state early. Individual
project failures do not stop other scopes. Simultaneous character-level editing
is outside this protocol; overlapping saved text remains a private draft.

Sockets use a 15-second, single-use ticket bound to the authenticated session and
explicit project IDs. Personal scopes cannot be subscribed. The server rechecks
live session and membership before upgrade, after control/write events, and on a
ten-second heartbeat. Connections expire after eight minutes to reauthenticate.
Notifications carry scope IDs, sequences, generations, epochs, and control
versions, without content, titles, email addresses, or access/refresh tokens.
Deploy one API process: in-memory notification fanout is not a multi-replica
transport. HTTPS/WSS and reverse-proxy upgrade forwarding are required remotely.

Passkeys work directly on the server's web origin. For native apps or a separate
custom-server origin, the app opens the server's account page for WebAuthn
approval. A pending password-authenticated login is bound to a device-only
random proof; the browser receives neither session tokens nor that proof. The
app polls and atomically redeems the approval. Approval expires after three
minutes, cannot be replayed, and is invalidated by vault recovery/password
changes. TOTP and MFA recovery codes also work directly in the app.

## Transactions, authentication, and retries

Routes live under `/api/v2/accounts/sync`; exact executable contracts are
[scope-routes.ts](../src/ultra-account/scope-routes.ts) and
[ultra-sync-contract.ts](../../shared-schema/src/ultra-sync-contract.ts).

| Route group                                                          | Purpose                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `/scopes`                                                            | List scopes; create personal/project scope with owner authorization                         |
| `/scopes/:scopeId/transactions`                                      | Conditional atomic replacement of up to 100 encrypted records                               |
| `/scopes/:scopeId/snapshot`, `/changes`                              | Consistent current heads, or only those changed since a cursor, plus their signed manifests |
| `/scopes/:scopeId/checkpoint`                                        | Retain the latest two explicit consistent checkpoints                                       |
| `/scopes/:scopeId/migration/finish`                                  | Validate the frozen import's record count and activate the personal scope                   |
| `/recipients`, `/invites`, `/scopes/:scopeId/invites`                | Verified recipient lookup, inbox, invitation creation/acceptance/revocation                 |
| `/scopes/:scopeId/provisioning`, `/provision`                        | Owner delivery of grants after an invited email registers                                   |
| `/scopes/:scopeId/rotation/start`, `/stage`, `/finish`, `/provision` | Freeze, automatically re-encrypt, and atomically publish a new generation                   |
| `/socket-ticket`, `/events`                                          | Single-use scoped WebSocket subscriptions                                                   |
| `/scopes/:scopeId/receipt`                                           | Account/device-bound uncertain-write receipts                                               |
| `/ownership/offers`, `/scopes/:scopeId/ownership/offer`, `/accept`   | Dual-signed ownership acceptance and automatic rekey                                        |
| `/scopes/:scopeId/checkpoints`, `/restore/start`, `/restore/source`  | Owner-authorized project restore                                                            |
| `/scopes/:scopeId/delete`                                            | Owner-signed project deletion                                                               |

Personal scope admission also requires the account's own owner identity, its
single owner membership, and the vault's personal content key. Cached scope kinds
cannot change. A server cannot relabel a project as personal to make the bridge
encrypt private data under a project key.

An account-certified device key signs each record and the complete encrypted
transaction manifest. AES-GCM authenticates the versioned record header, including
server/scope/actor/device/mutation IDs, key epoch, generation, control version,
counter, and base/new revisions. The owner signs each member's role, public keys,
and HPKE grant. Clients pin owner/recipient identities on first use; this is not
a public-key transparency system. Invitations are accepted with the recipient's
account signature. Passwords and content keys are never sent to the server.

Writes lock the live session and scope before checking membership and revisions.
Every read/write/key-management route enforces current membership; viewers cannot
write shared records. All expected revisions must match or no record commits.
The server retains current encrypted heads, permanent tombstones, complete signed
manifests, and account/device-bound monotonic retry receipts. Exact retries return the
committed result, including across a later key rotation. Clients persist the
exact pending ciphertext and its key before sending, so a lost response or restart
does not create a second mutation. A viewer downgrade preserves unsent edits
as private drafts; an own-account receipt acknowledges a previously committed
write even when the writer no longer has permission to resubmit it.

A device's first download is the complete set of consistent current heads.
Afterwards, a client sends its cursor with `delta=1` and receives only the heads
written after that cursor, with the manifests that authenticate them. The server
reads them in the same locked transaction as the scope, through the
`(scope_id, mutation_id)` index. Heads are never removed within a generation
(deletes are tombstones), so overlaying the delta reaches the same state as a full
snapshot. A delta never crosses a generation: after rekeying, ownership transfer or
restore, and for any request without `delta=1`, the server returns the complete
snapshot. Each response names the mutation at its sequence (`cursorMutationId`),
and the client sends it back as `afterMutation`. If the database no longer has that
mutation at that sequence, for example after restoring an older backup and
committing again, the server returns the complete snapshot instead of "unchanged"
or a delta. Clients verify a delta exactly like a snapshot and validate project
hierarchy on the merged result. Within one generation they also reject any
response, delta or complete, that returns an older revision of a record they hold
or omits one. A device that already synced past a restored backup therefore stops
with an error instead of silently diverging; it needs an explicit reconnect.
Servers advertise `incrementalChanges` for discovery; clients always ask, and a
server without it ignores the parameter and returns the complete snapshot. Upgrading
builds the `(scope_id, mutation_id)` index without `CONCURRENTLY`, which briefly
blocks writes to record heads on large installations. A request with the current
control version and generation can reuse its previously authenticated membership
list (`controlUnchanged`); clients reject a compact response if owner, key epoch,
generation, control version, or ownership history differs from their cached
control. Identical verified memberships/certificates use bounded per-client
caches; new signed values are always authenticated. Scope keys are unwrapped
again when their authenticated grants change.

Disjoint object fields merge with base/local/remote values. String-ID list changes
combine independent additions/removals and detect conflicting order changes.
Overlapping text/scalars keep the committed value and preserve the local value
as a private conflict draft. Deletes beat stale edits. Restoring a deleted record
requires an explicit restore against the current tombstone revision; stale edits
never acquire that permission during rebase. The personal bridge uses this for
legacy undo and archive restoration. The app exposes draft export and explicit dismissal;
20 unresolved drafts per record pause further conflicts instead of discarding
older drafts. Hierarchy cycles are rejected by the shared client model.

## Invitations and automatic removal

Invite a verified email or username as editor or viewer. Existing users receive
owner-signed HPKE grants for their account public key. Unknown email addresses
enter a provisioning state until registration/verification and an unlocked owner
device prepares the grant. Email is generic and contains no project title, content,
key, or sharing password. Invitations expire after seven days; the authenticated,
verified inbox is used rather than a bearer invitation URL.

Removing a member immediately removes their server access and freezes new shared
writes. An unlocked owner client automatically prepares a new key, wraps it for
remaining members, re-encrypts every current head/tombstone, and publishes the new
generation atomically. Staged state and encrypted owner grants make interruption
resumable on another unlocked owner device. No manual key step is required.
Pending grants are reprovisioned for the new epoch. A removed member can retain
content/keys already downloaded. The owner cannot remove themselves; ownership
transfer requires acceptance by an existing member.

## Ownership, project restore, and deletion

The owner offers ownership to an existing member, including a viewer. The offer
expires after seven days or a membership/control change. Both owners sign the
exact next identity and key grants; clients verify the appended proof chain
against their previously pinned owner. Acceptance freezes writes, automatically
reencrypts every head under a new key, and publishes the new owner/epoch/generation
atomically. The previous owner becomes an editor. Any unlocked recipient device
can resume an interrupted transfer. Ownership history is bounded to 100 transfers
per project. Pending invitations are retired on transfer and can be sent again
by the new owner.

Project recovery keeps the latest two explicit encrypted restore points within
the current key epoch. Only the owner can list/restore them. Restoring publishes
a new generation; it reinstates saved records and tombstones records created
later. It does not import a personal backup, replace private overlays, or roll
back another member's time. Overlapping offline work becomes a private draft.
Rekeying retires previous checkpoints rather than escrow old content keys.

Deleting a project requires the owner's current control version and signature.
The app confirms that deletion affects everyone, while downloaded/exported copies
cannot be erased. Account deletion (`POST /api/v2/accounts/delete`) requires a
recent full login and vault-key proof. It refuses while the account owns any
project. Transfer or delete those projects first. Deletion removes the personal
scope and authentication records, revokes memberships immediately, and freezes
remaining shared projects for automatic owner rekeying. A departing member may
already know a staged key, so any old rekey stage is discarded. The next unlocked
owner device provisions a fresh key and completes the rekey without a key prompt.
Local personal task databases and exported backups remain; the app clears the
deleted account's encrypted native cache and native background credentials.
Retained shared ownership proofs, signatures, and encrypted history can still
contain the former account ID/public keys; collaborators' shared copies and
private histories are not erased.

## Migration and app integration

The native page requires legacy sync to be disabled and an explicit acknowledgement
that old targets/devices have been retired. It saves a local recovery point first.
Import this device's data is for an empty account; Use the account's existing data
explicitly replaces this device's dataset while keeping that recovery point.
A frozen encrypted migration journal uploads bounded batches and resumes on the
same installed device. Another device cannot write into an in-progress import.
The server activates the scope only after the inventory count matches. Source
data survives interruption; subsequent local changes are captured separately.

Personal views keep the durable local operation log. A bridge maps its current
projection to encrypted records, rebases remote results, and reuses the existing
deferred-action snapshot replacement path. Its encrypted account-bound baseline,
task state, archives, and local clock commit atomically. Pending timer deltas are
excluded until their local operation is flushed. A single native workspace lease
prevents two account profiles from concurrently owning the same local dataset;
switching accounts requires a new explicit data choice.

Shared projects currently use the native page inside the app. They are not yet
projected into legacy Today/worklog/boards or plugin/REST/MCP task APIs.
Private shared-task plans and time can be exported there, including references
to unavailable projects. Large legacy bulk changes can span several 100-record
transactions; there is no cross-scope atomic write. A delta is one response, not
a paginated stream: a device that was offline through many changes downloads all of
them at once, at most the size of a full snapshot.
Automatic legacy account fencing/final sync and provider retirement belong to
the cutover milestone; this rollout does not silently dual-write legacy targets.

## Platform sessions and reminders

Android keeps a narrow read-only background profile in Keystore-backed
EncryptedSharedPreferences, excluded from cloud backup/device transfer. It holds
rotating session tokens, current scope content keys, pinned owner metadata, and
verified reminder cursors. It never receives the password, master key, or account
signing/decryption private keys. The bridge and WorkManager worker serialize
refresh so foreground and background cannot consume the same token. There is
no plaintext storage fallback. iOS stores its session in device-only Keychain
storage and uses the same serialized refresh rule.

Signing in binds session refresh only. Content keys and reminder projections
reach the native worker after the explicit personal-data link choice; reopening
an unlinked account removes previously managed reminders immediately.

The Android worker verifies owner membership, account-certified device keys,
transaction/record signatures, inventory, and AES-GCM context before reading
reminder fields. It applies alarm changes before committing cursors. Locally
changed reminder slots are protected from background replacement until a
foreground personal sync acknowledges the captured protection version; newer
local changes keep their markers. A waiting foreground request yields the worker
between scope downloads, so a slow multi-project job cannot monopolize refresh.
Corrupt or revoked projects are isolated, revoked sessions clear credentials, and ordinary
network failures preserve the last verified reminders. WorkManager runs at a
best-effort 15-minute interval; this is not a background real-time guarantee.

The worker does not hold account private keys to unwrap a new project epoch.
After key rotation/ownership transfer it suspends that project's reminders until
the next unlocked foreground handoff supplies current keys. Owner rekeying itself
is automatic. Shared reminders are private overlays; completion cancels this
member's reminder without touching another member's timer. A shared notification
tap opens the native project page. Shared notifications have no background Done
or Snooze actions. Ordinary personal reminders and SuperSync use their existing
platform paths.

iOS performs a best-effort shared flush on suspension and catches up on resume;
it does not promise periodic background polling. iOS schedules local shared
reminders while unlocked and reconciles them on return. Web/Electron reminders
require notification permission and an active renderer. Locking clears native
sessions/keys and native shared reminders after atomically saving the latest
rotating credential in the encrypted app cache. Sign out revokes the current
server session and removes that cache; if offline, it still locks and clears
this device and reports the failed revocation. Lost refresh responses can require a
new login because refresh reuse revokes the session; pending content intents
remain encrypted and durable.

## SuperSync compatibility

SuperSync remains an optional personal-sync provider with its existing v1 API,
credentials, separate encryption password, workers, and upstream compatibility.
An Ultra Tasks server can expose both legacy v1 and native v2 routes, while stock
SuperSync serves the legacy mode. Native password-vault accounts, 2FA, scoped ACLs,
and sharing require an Ultra-capable server. Choose one personal-sync mode for
a local profile; do not dual-write the same personal dataset. Provider retirement
and a fully automated legacy write fence remain the cutover milestone.

## Bounds and validation

Personal scopes allow 50,000 heads/tombstones and 32 MiB of current ciphertext;
projects allow 5,000 and 8 MiB. Native reminder downloads cap an individual HTTP
response at 32 MiB; an oversized scope suspends that scope’s background alarms
until it can be handled in the foreground. Ordinary writes stop at 128 MiB of manifest
history. Rekey staging can temporarily store additional ciphertext and manifest
copies; storage tuning for large projects remains a release gate. A scope retains
at most 5,000 device receipts and two explicit checkpoints. Referenced manifests remain while
their heads exist; other history is retained for 30 days. Tombstones count against
quota for the life of a scope. A transaction has at most 100 records and an 8 MiB
HTTP body; each encrypted payload is at most 100,000 base64url characters. Quota
errors retain local pending changes. Accounts have at most 101 scope memberships;
projects have at most 50 active members and 100 stored invitations (accepted
invitations also count). The owner can revoke stored invitations via the API.

Run `account-crypto:test`, `ultra-sync:test`, `ultra-sync:browser`, the account
security tests, server regression suite, and app tests through the root quiet
wrapper. The native browser script builds the app and uses real Chromium, real
OPAQUE/HPKE/WebCrypto, two account passwords, and the shipped migrations in
PGlite. A November 6, 2026 loopback HTTP/WebSocket run with PGlite, 20 accounts and five
certified SDK devices per account measured 1,000 deliveries at p50 649 ms,
p95 848 ms, maximum 985 ms. Authentication setup is outside the measurement;
five devices share each account's session but have independent signing keys and
storage. This validates the declared foreground target in that test environment,
not production PostgreSQL capacity or mobile background latency. Run the
separate `ultra-realtime:load` script without competing builds. `ultra-realtime:test`
and `ultra-recovery:test` cover sockets, fallbacks, recovery and permission races.
Native JVM fixtures are generated by `tools/generate-native-sync-fixtures.mjs`;
Android emulator tests and unsigned iOS compilation plus a WKWebView/Keychain
simulator smoke run on the feature branch.
Production PostgreSQL load/restore drills, physical-device performance, and
independent security review remain release gates. This does not encrypt the existing local task DB,
erase downloaded content on revocation, or claim malicious-server directory
transparency.
