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
dates, scratch notes, and logged time. An overlay arriving before its project,
or surviving removal, remains personal data and can be exported. Descriptions
are excluded by default when copying a personal project; the source project and
its personal data remain intact. No integration credentials or historic time
are copied into a shared scope.

While unlocked, both kinds of scope sync every 60 seconds, on reconnect/return
to the app, and through Sync now. Shared UI edits save to the encrypted local
outbox first. They do not flush private data immediately. Scope errors are
isolated so a malformed project does not prevent personal sync. This release
does not implement WebSocket delivery, concurrent rich-text coediting, or native
background scheduling; those are later implementation milestones.

WebAuthn sign-in requires an app origin permitted by the server's relying-party
ID (for example, serving the web app and API at the same origin). For a separate
custom-server origin or native WebView, use TOTP or an MFA recovery code until
the platform/browser authentication handoff is implemented. Enrollment and
WebAuthn login at the server's own `/account` portal remain available.

## Transactions, authentication, and retries

Routes live under `/api/v2/accounts/sync`; exact executable contracts are
[scope-routes.ts](../src/ultra-account/scope-routes.ts) and
[ultra-sync-contract.ts](../../shared-schema/src/ultra-sync-contract.ts).

| Route group                                            | Purpose                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| `/scopes`                                              | List scopes; create personal/project scope with owner authorization                   |
| `/scopes/:scopeId/transactions`                        | Conditional atomic replacement of up to 100 encrypted records                         |
| `/scopes/:scopeId/snapshot`, `/changes`                | Consistent current heads plus signed transaction manifests; unchanged-cursor shortcut |
| `/scopes/:scopeId/checkpoint`                          | Retain the latest two explicit consistent checkpoints                                 |
| `/scopes/:scopeId/migration/finish`                    | Validate the frozen import's record count and activate the personal scope             |
| `/recipients`, `/invites`, `/scopes/:scopeId/invites`  | Verified recipient lookup, inbox, invitation creation/acceptance/revocation           |
| `/scopes/:scopeId/provisioning`, `/provision`          | Owner delivery of grants after an invited email registers                             |
| `/scopes/:scopeId/rotation/start`, `/stage`, `/finish` | Freeze, re-encrypt, and atomically publish a new project generation                   |

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
manifests, and per-device monotonic retry receipts. Exact retries return the
committed result, including across a later key rotation. Clients persist the
exact pending ciphertext and its key before sending, so a lost response or restart
does not create a second mutation.

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
transfer and account deletion are later recovery work.

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
projected into legacy Today/worklog/boards/reminders or plugin/REST/MCP task APIs.
Private shared-task plans and time can be exported there, including references
to unavailable projects. Large legacy bulk changes can span several 100-record
transactions; there is no cross-scope atomic write. Changed scopes currently
download full consistent heads rather than a paginated incremental stream.
Automatic legacy account fencing/final sync and provider retirement belong to
the cutover milestone; this rollout does not silently dual-write legacy targets.

## Bounds and validation

Personal scopes allow 50,000 heads/tombstones and 32 MiB of current ciphertext;
projects allow 5,000 and 8 MiB. Ordinary writes stop at 128 MiB of manifest
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
PGlite. Large-project storage/latency tuning, production PostgreSQL/native-worker parity, and independent security
review remain release gates. This does not encrypt the existing local task DB,
erase downloaded content on revocation, or claim malicious-server directory
transparency.
