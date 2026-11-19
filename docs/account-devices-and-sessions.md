# Ultra Tasks account devices, new-device email verification and sessions

Status: server beta 2 design and implementation record (November 18, 2026). The
design was written before the implementation and then corrected after two
independent reviews of the code; the final sections record what was built, what was
tested, what was not and the residual risks. SDK `0.1.5` is the first client library
that speaks this protocol. Server and SDK release numbers stay independent of the
application's version.

This document covers three related server behaviors:

1. **New-device email verification**: a default-on, opt-out email challenge for
   sign-ins from a device the account does not already recognize.
2. **Trusted devices**: the opaque device token that waives that challenge, and the
   list/revoke API that goes with it.
3. **Session policy**: sliding idle lifetime, absolute cap, live-session cap and
   self-identifying, generation-numbered refresh tokens (nothing is stored per
   refresh), so a device in regular use is not signed out by calendar age.

Product wording: the account is called the **Ultra Tasks account**. The feature is
called **New-device email verification**. This page is operator and integrator
documentation; user-facing copy belongs to the clients.

## What this is, and what it is not

New-device email verification asks a person who has just proved the account
password from an unrecognized device to also type a short code that was sent to the
account's verified email address. It is a **second check on a password-only
sign-in**, not a second authentication factor.

It does provide:

- A password that leaks (reuse, credential stuffing, a phishing page that does not
  also read the user's mail) is not enough to start a session, fetch the encrypted
  vault bundle or reach encrypted sync data from a new device. The server issues no
  session until the code is accepted.
- The account owner receives an email each time the correct password is used from an
  unrecognized device, which is an early warning even when the attacker cannot read
  the mailbox.
- Existing sessions, local unlock and ordinary sync/refresh are unaffected. Nothing
  is emailed for refresh, wake, offline unlock or a recognized device.

It does **not** provide, and must not be described as:

- **Multi-factor authentication, or equivalence to an authenticator app or security
  key.** NIST SP 800-63B-4 does not accept email as an out-of-band authenticator.
  This feature makes no authenticator-assurance claim.
- **Phishing resistance.** A real-time relay that collects the password and the code
  and replays both succeeds. WebAuthn security keys remain the phishing-resistant
  option; they are separate and take precedence.
- **Protection against someone who controls the mailbox.** The same mailbox is the
  account recovery channel (recovery additionally needs the printed recovery key).
- **Protection against a compromised trusted device.** Malware on a signed-in device
  already holds a session and the unlocked vault.
- **A change to end-to-end encryption.** The vault key is still derived from the
  password and recovery key on the client. The server never receives either, and the
  email never contains a key, a link with a secret or any vault material.

Enrolled TOTP or WebAuthn factors **always take precedence**. An account with a
second factor gets exactly the existing MFA flow: no email challenge replaces it or
adds to it, and a device token never skips it.

## How a sign-in is decided

`POST /login/finish` runs after the OPAQUE password proof succeeded. Only then does
the server look at the device token or consider an email challenge, so an attacker
without the password cannot probe tokens or learn whether an account has the
feature.

```
unverified email                         -> 403 "Verify your email before signing in" (unchanged)
enrolled TOTP/WebAuthn factor            -> MFA exactly as before (never email)
feature off, or account opted out        -> session (+ device record when the client declared support)
device token recognised for this account -> session
client did not declare "deviceEmail"     -> 426 client_update_required (no session)
otherwise                                -> email challenge; no session until the code is accepted
```

"Feature off" means the operator set `ULTRA_DEVICE_EMAIL_VERIFICATION=false` or the
server has no SMTP configuration (a warning is logged at startup in that case). In
that state `/capabilities` reports `newDeviceEmailVerification: false`, no challenge
is created, and **no device tokens are minted**, so turning the feature on later
challenges every device once instead of trusting whatever signed in while the control
was off. When only the account has opted out, device tokens are still minted, but
turning the setting back on forgets every device except the one making the change (see
"Account changes that affect devices and challenges"), so trust that was minted while
the owner had the check switched off does not outlive it.

A client that cannot display a code never receives a session it did not earn. It gets
`HTTP 426` with `code: "client_update_required"` and the message "Update Ultra Tasks
to sign in on a new device." Sessions it already holds continue to refresh.

## Device recognition (device-token model)

A **device token** is 256 random bits, base64url encoded (43 characters), created by
the server. Only its SHA-256 digest is stored (`ultra_devices.token_digest`).

- It is an opaque trust marker, never a credential. It authenticates nothing by
  itself; it only waives the email challenge **after** a correct password proof for
  the **same account**. A token that belongs to another account, was removed, was
  pruned, has gone unused for the idle window or never existed is simply "not
  recognized".
- Device names, client identifiers, IP addresses and user agents are never trust
  evidence and are not stored. There is no fingerprinting. The only client-supplied
  string kept is the display label (the device name the user sees in Devices), with
  control and bidirectional-override characters replaced and at most 100 characters.
- The server issues a new token when a device is first trusted: after a verified
  email challenge, after an approved browser-to-app sign-in, after MFA completes, or
  when the account has opted out (the client must have declared support). A
  recognized device keeps the token it already holds; the server does not echo or
  rotate it, so a lost response cannot orphan it.
- The client stores the token where it stores its other device secrets (desktop:
  OS-protected storage; web: `localStorage` scoped by server and account) and sends
  it on every password sign-in. Treat it like a refresh credential: do not log it.
- **Trust follows use.** A device is recognized only while it has been active inside
  the session idle window (180 days by default): its last sign-in, or the latest
  refresh of any of its sessions, counts. A phone used weekly is never asked again;
  a laptop left in a drawer for the whole window is asked once more. The same rule
  hides such a device from the Devices list.
- Trust also ends when the user removes the device, when the password is changed
  (every device except the one making the change), when the account is recovered (all
  devices), when the setting is turned back on (every device except the one making the
  change), when the account is deleted, or when the least recently active record is
  pruned at 30 devices per account.
- **A removed device is deleted, not flagged.** Removing a device ends its sessions and
  then deletes its record. A device whose trust lapsed (unused for the whole idle window)
  is deleted the next time a sign-in is issued for the account. The `revoked` column that
  the migration creates is never read and never set: nothing about trust depends on it,
  so flagging a row by hand does **not** remove its trust (delete the row instead).
- Sessions are bound to the device record that was trusted when they were issued
  (`ultra_sessions.device_id`, a foreign key that becomes empty when the record is
  deleted). Removing a device revokes every session bound to it first. Deleting a record
  for any other reason (pruning, a lapsed device, turning the setting back on) clears the
  link instead of ending the session: the session keeps syncing but is no longer bound to
  a trusted device, so it cannot approve a browser sign-in for a new device.
- A recognized device keeps the label it was first trusted under. A later sign-in updates
  only its last-seen time, so a password holder cannot rename a device the owner already
  knows.

## Challenge parameters

| Parameter                       | Value                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Code                            | 8 digits from a CSPRNG; only an HMAC-SHA-256 is stored                          |
| Code lifetime                   | 10 minutes from the first send; resend does not extend it                       |
| Wrong-code attempts             | 5 per challenge, **shared across resends** (resend never resets)                |
| After 5 wrong attempts          | Challenge locked; even the correct code fails; sign in again                    |
| Resend cooldown                 | 30 seconds (also before the first resend)                                       |
| Resends per challenge           | 3                                                                               |
| Pending challenges per account  | 12, equal to the hourly email budget, so none is evicted                        |
| Emails per account              | 12 per hour, first codes and resends together (`429 verification_rate_limited`) |
| Challenge token                 | 256 random bits (43 characters), stored as SHA-256 digest                       |
| Consumption                     | Single use, inside one account-locked transaction                               |
| Trusted devices per account     | 30; the least recently active record is deleted first                           |
| Device trust                    | While active inside the idle window (default 180 days)                          |
| `/login/finish`, `/login/start` | 30 requests / 15 minutes / IP (existing route limit)                            |
| `/login/device/verify`          | 30 requests / 15 minutes / IP                                                   |
| `/login/device/resend`          | 10 requests / 15 minutes / IP                                                   |
| `/security/new-device-email`    | 30 requests / 15 minutes / IP                                                   |

Storage and handling rules:

- The code is bound to the challenge and the account:
  `HMAC-SHA-256(ULTRA_AUTH_SECRET, "device-email-v1" | challengeDigest | accountId | code)`.
  The HMAC lives inside the encrypted challenge payload. A code from another
  challenge or account never verifies.
- Comparison is constant time over fixed-length digests. Every failure (unknown,
  expired, locked, replayed, wrong, wrong account) is the same generic `401`.
- The code is never logged and appears only in the email body. The email contains no
  link, no key and no client-supplied text (the device label is not echoed, so an
  attacker cannot inject words into a message sent from the operator's address).
- If the mail provider fails, the server answers `503`, removes the challenge and
  issues no session. A failed resend also removes the challenge. Mail is sent only
  after the database transaction committed, so a slow provider never holds an account
  lock.
- The per-account email bound is one self-expiring counter row (`device-email-budget`)
  in the challenge table; a refusal rolls back with its transaction and leaves nothing
  behind. Recognized devices, MFA and sessions in use never spend it. A password change
  and an account recovery delete the row, so the owner who has just regained control is
  not locked out by emails that someone else spent.
- At most 12 challenges can be pending and every challenge costs one email of that same
  budget, so the budget refuses the thirteenth before any pending code could be evicted:
  nobody can push the owner's pending code out, they can only spend the budget.

## API reference

All routes live under `/api/v2/accounts`. JSON bodies are strict: unknown keys are
rejected, which is why the SDK sends the new keys only when the server advertises the
feature.

### Capabilities

`GET /capabilities` adds to `features`:

```json
{
  "newDeviceEmailVerification": true,
  "trustedDevices": true,
  "sessionLifetime": "sliding-v1"
}
```

`newDeviceEmailVerification` is `true` only when the feature is enabled **and** SMTP
is configured. `trustedDevices` means the device routes below exist.
`sessionLifetime: "sliding-v1"` is a string value among the boolean flags.

### Password sign-in

`POST /login/start` is unchanged. `POST /login/finish` accepts two optional keys:

```json
{
  "loginToken": "<43 chars>",
  "finishLoginRequest": "<opaque>",
  "deviceToken": "<43 chars, optional>",
  "clientFeatures": ["deviceEmail"]
}
```

Send them only when `capabilities.features.newDeviceEmailVerification` is true.
`clientFeatures: ["deviceEmail"]` declares that the client can show the code step and
store a device token. Feature names the server does not know are ignored; a name must
be 1 to 32 letters or digits starting with a letter, and at most eight are accepted
(anything else is `400`).

Possible `200` bodies:

```json
// session (unchanged fields; deviceToken only when a token was newly issued)
{ "accessToken": "...", "refreshToken": "...", "expiresIn": 600,
  "account": { "id": "...", "email": "...", "username": null, "displayName": "", "vaultVersion": 1 },
  "deviceToken": "<43 chars>" }

// MFA (unchanged; the email challenge never applies)
{ "mfaToken": "<43 chars>", "factors": ["totp", "webauthn"] }

// email challenge; no session yet
{ "verification": { "kind": "email", "token": "<43 chars>", "expiresIn": 600,
                    "resendAfter": 30, "resendsLeft": 3, "emailHint": "d***@example.test" } }
```

Errors: `403` unverified email; `401` generic;
`409 { "code": "session_limit" }` when the account is at its live-session cap and no
session can be retired (checked before an email is sent);
`426 { "error": "Update Ultra Tasks to sign in on a new device.", "code": "client_update_required" }`;
`429 { "code": "verification_rate_limited" }` when the per-account email bound is spent;
`503 { "error": "Email could not be delivered. Please try again.", "code": "email_delivery_failed" }`.

Any error body may carry a machine-readable `code` next to `error`. The SDK exposes it
as `AccountApiError.code`. Clients must not parse `error` text.

### Verify and resend

```
POST /login/device/verify   { "token": "<43>", "code": "12345678" }
  200 { accessToken, refreshToken, expiresIn, account, deviceToken }
  401 { "error": "Invalid or expired verification code" }
  409 { "code": "session_limit" }   // answered before the code is compared, whatever the code

POST /login/device/resend   { "token": "<43>" }
  200 { "verification": { kind, token, expiresIn, resendAfter, resendsLeft, emailHint } }
  401 generic (unknown, expired or locked challenge)
  429 { "error": "...", "code": "resend_too_soon" }               // inside the 30 s cooldown
  429 { "error": "...", "code": "resend_limit" }                  // three resends already sent
  429 { "error": "...", "code": "verification_rate_limited" }     // per-account email bound
  503 { "error": "...", "code": "email_delivery_failed" }         // challenge removed
```

`token` stays the same across resends; each resend replaces the code. The `code` must
be eight digits (anything else is `400`). A client that receives `401` or `503` from a
resend should start the sign-in again; `429` keeps the challenge.

### Settings and devices

```
GET  /me                         adds  "settings": { "newDeviceEmailVerification": true }
POST /security/new-device-email  { "enabled": false, "code": "<MFA code, only if a factor is enrolled>" }
  200 { "newDeviceEmailVerification": false }
  403 stale sign-in (older than 10 minutes), 401 missing/wrong MFA code
GET  /devices
  200 [ { "id": "<uuid>", "label": "Windows desktop", "createdAt": 1790000000000,
          "lastSeenAt": 1790000000000, "current": true, "sessions": 1 } ]
POST /devices/revoke             { "deviceId": "<uuid>", "code": "<MFA code, another device only>" }
  200 { "revoked": true }
  403 stale sign-in (older than 10 minutes), 401 missing or wrong MFA code (another device only)
GET  /sessions                   rows add  deviceId (uuid|null), lastSeenAt (ms), trusted (bool)
                                 at most 100 rows: the caller's own session first, then the newest
```

Changing the setting needs a sign-in within the last 10 minutes (`requireRecent`), and,
when TOTP or WebAuthn is enrolled, a valid MFA or recovery code to **disable** it
(enabling is the safe direction and accepts but ignores a code). A stolen refresh
session cannot disable the protection because refresh never renews `auth_at`.
`/devices` lists the devices still inside the idle window, most recently active first;
`lastSeenAt` is the later of the last sign-in and the latest session refresh.

`/devices/revoke` ends the device's sessions and deletes the device. Removing **the
device the caller is signed in on** needs nothing beyond the session. Removing **any
other device** is a security change like the new-device setting: it needs a sign-in
within the last 10 minutes (`403` otherwise) and, when TOTP or WebAuthn is enrolled, a
valid MFA or recovery code in the optional `code` (`401` when it is missing or wrong; a
recovery code is consumed by use), so a stolen refresh session cannot strip the owner's
other devices. The call is idempotent: once those checks pass, an unknown id is `200`.
The SDK's `revokeDevice(deviceId, code?)` sends `code` only when one is given.

`GET /sessions` returns at most 100 rows: the caller's own session first, then the
newest. A revoked session stays listed for 30 days after its last activity and is then
deleted, together with expired ones, the next time any session is issued. `lastSeenAt` is
the later of the session's sign-in and its latest refresh.

## Browser-to-app approval

`/browser-login/approve` and `/browser-login/poll` are unchanged except for these
additive rules:

- If the account would require the email check for this device (feature on, account
  opted in, no enrolled factor), the **approving** session must itself have satisfied
  that policy: it must be bound to a device that is still trusted. Otherwise approval
  is refused with `403 { "code": "device_verification_required" }`; the person signs in
  again on that browser (which verifies the device) and retries. Sessions issued before
  this feature existed or while it was off, and sessions whose device record was deleted
  since, carry no device binding, so they cannot approve until their owner signs in again.
- The approval is bound to the account, the vault version and the live approving
  session exactly as before. The poll still re-checks that the approving session is
  live, so revoking the approving device before the app redeems cancels the sign-in.
- `/browser-login/poll` accepts the same two optional keys as `/login/finish`. When the
  app declared `deviceEmail`, the new session is bound to a trusted device and the
  response gains `deviceToken` (only if newly issued). Apps that do not declare it get
  the previous response unchanged.
- MFA-protected accounts: unchanged. The approving session already passed MFA.

## Account changes that affect devices and challenges

| Event                              | Effect                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Email address change verified      | Pending `device-email` challenges deleted (the code went to the old inbox)                                                                     |
| Password change (signed in)        | All sessions revoked, pending challenges and the email budget deleted, every device except the current one deleted                             |
| Account recovery                   | All sessions revoked, pending challenges and the email budget deleted, **all** devices deleted                                                 |
| TOTP/WebAuthn enrolled             | Pending challenges deleted; other sessions revoked (existing)                                                                                  |
| TOTP/WebAuthn removed              | Other sessions revoked (existing); devices keep their trust, so the email check applies again to new devices                                   |
| Device removed in Devices          | The device's sessions are revoked and its record is deleted; another device also needs a recent sign-in and the MFA code                       |
| New-device verification turned off | No new challenges; devices keep their tokens; tokens are still issued                                                                          |
| New-device verification turned on  | Every device except the one making the change is forgotten (its sessions keep syncing, unbound) and is challenged on its next password sign-in |
| Account deleted                    | Devices, sessions and challenges deleted with the account                                                                                      |

## Failure matrix

| Situation                                                 | Result                                                                                              |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| SMTP down on the first send                               | `503`, challenge removed, no session; sign in again later                                           |
| SMTP down on resend                                       | `503`, challenge removed; sign in again                                                             |
| SMTP slow                                                 | Mail is sent after the commit; no account lock is held while waiting                                |
| Code expired (10 minutes)                                 | Generic `401`; sign in again for a new challenge                                                    |
| Code replayed after success                               | Generic `401`; the challenge was deleted with the session                                           |
| Wrong code                                                | Generic `401`; attempt counted and committed                                                        |
| Fifth wrong code                                          | Challenge locked; the right code now fails too; resend cannot revive it                             |
| Resend inside 30 seconds / after 3 resends                | `429` with `resend_too_soon` / `resend_limit`; attempts untouched                                   |
| More than 12 emails in an hour for one account            | `429 verification_rate_limited` on a new sign-in or a resend; recognized devices unaffected         |
| Code from another challenge or account                    | Generic `401`; counts as an attempt on the challenge the token names                                |
| Challenge abandoned                                       | Expires; no session or device record was created                                                    |
| Verify response lost on the network                       | Challenge already consumed and the session exists unseen; sign in again (new email)                 |
| Reinstall / cleared storage                               | Token gone: one new challenge; the old record stays listed until removed, pruned or lapsed          |
| Device unused for the whole idle window                   | Token no longer recognized; one new challenge                                                       |
| Device removed                                            | Its sessions end; its token is no longer recognized; next password sign-in is challenged            |
| Password changed while a challenge is pending             | Pending challenge deleted; code cannot be used                                                      |
| Email changed while a challenge is pending                | Pending challenge deleted                                                                           |
| Account recovered                                         | All trust reset; first sign-in on each device is challenged                                         |
| TOTP/WebAuthn enrolled while pending                      | Pending challenge deleted; verification never issues a session for an account with a factor         |
| Account has enrolled factors                              | MFA only; no email challenge, no email substitute                                                   |
| 30 live sessions, some unused for a day                   | The least recently active unused session is retired when a sign-in is actually issued               |
| 30 live sessions, all active within a day                 | `409 session_limit` **before** any email is sent, and before a code is compared                     |
| Refresh token of an earlier generation replayed           | The whole session is revoked and the answer is a generic `401`, however many rotations ago          |
| Refresh token forged, truncated or for an unknown session | `401` (`400` for a wrong length); nothing is read or written and nothing is revoked                 |
| Refresh response lost on the network                      | The retry replays the previous generation: the session is revoked, sign in again (known limitation) |
| Operator kill switch (`false`)                            | No challenges, no new tokens; clients see the capability disappear                                  |
| Old client (SDK 0.1.4 and earlier)                        | `426` on a new device with the feature on; unchanged behavior otherwise                             |

## Compatibility

| Client                | Server                                  | Behavior                                                                                      |
| --------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------- |
| SDK 0.1.4 and earlier | beta 3 and earlier                      | Unchanged                                                                                     |
| SDK 0.1.4 and earlier | beta 2 (this), feature off or opted out | Unchanged password login; no device bookkeeping                                               |
| SDK 0.1.4 and earlier | beta 2, feature on, new device          | `426 client_update_required`; no bypass; existing sessions keep syncing                       |
| SDK 0.1.4 and earlier | beta 2, account has MFA                 | MFA exactly as before                                                                         |
| SDK 0.1.4 and earlier | beta 2, browser sign-in                 | Works when the approving session is trusted; otherwise approval is refused in the browser     |
| SDK 0.1.5             | beta 3 and earlier                      | Capability absent: no new keys sent, no code step; `getSecuritySettings().available` is false |
| SDK 0.1.5             | beta 2 (this)                           | Full behavior                                                                                 |

Database compatibility: the migration is additive. An older server binary runs
against the migrated schema (it ignores the new columns and table); see rollout for the
one exception, refresh tokens.

Refresh tokens: clients must treat the refresh token as an opaque, non-empty string.
Sessions issued by this release carry a 48-character token. The 43-character form of
earlier servers is still accepted and is replaced by the new form at its first refresh,
and `/sessions/refresh` accepts either length. The SDK and the dashboard store the token
and send it back without inspecting it; the native applications are expected to do the
same, which should be confirmed before release.

## Session policy

| Item                      | Value                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------- |
| Access token              | 10 minutes (unchanged)                                                                         |
| Refresh token             | Single use, rotates on every refresh; 48 characters that name their own session and generation |
| Idle lifetime (sliding)   | 180 days: `ULTRA_SESSION_IDLE_DAYS`; renewed on issue and on every successful refresh          |
| Absolute lifetime         | 1095 days from issue: `ULTRA_SESSION_MAX_DAYS`; `0` removes the cap                            |
| Live sessions per account | 30 (was 20); see the overflow rule below                                                       |
| Refresh storage           | One generation counter on the session row; no row per refresh                                  |
| Revoked sessions kept     | 30 days after their last activity, then deleted                                                |
| Sessions list             | At most 100 rows: the caller's own session first, then the newest                              |
| Recent-sign-in window     | 10 minutes since `auth_at`; refresh never updates `auth_at`                                    |

- `idle_expires_at = min(expires_at, now + idle)` on issue and on every successful
  refresh. `expires_at` is set once, at issue, so refresh can never extend the absolute
  cap. Sessions issued before this release keep their stored expiry until their next
  refresh; refresh then recomputes only the idle value, so a pre-existing session still
  ends at its original 90-day absolute date, after which one sign-in creates a session
  with the new policy.
- Calendar age alone no longer signs a trusted device out. Explicit sign-out, device
  removal, password change, recovery, MFA changes and refresh-token reuse still
  revoke sessions immediately, and the 10-minute `requireRecent` rule still guards
  every sensitive change (password, factors, email, account deletion, the new-device
  setting, removing another device), so a long-lived session does not become a fresh
  authorization.
- **Overflow rule for the 30-session cap.** Raising the idle window from 30 to 180
  days makes orphaned sessions live six times longer: every sign-in creates a session,
  and a client that signs in again after a restart (installed beta 1 apps do, because
  they cannot restore a session) leaves the earlier one unused. Refusing the 31st
  sign-in would lock the owner out of every path, the dashboard included. So when a
  sign-in is **actually issued** (after the password, code or approval was accepted) at
  the cap, the least recently active session that has seen no sign-in or refresh for a
  day is retired to make room. A session active within the last day is never retired,
  and a flood of fresh sign-ins is still refused with `409 session_limit`. Nothing is
  retired merely because someone sent a password: the check before an email is
  read-only.
- **Refresh tokens name their own generation.** A version 2 refresh token is
  `base64url(session id | generation | mac)`: the session's UUID as 16 bytes, a 32-bit
  big-endian generation counter and a 16-byte MAC, 36 bytes or 48 characters, opaque to
  clients. The MAC is the first 16 bytes of
  `HMAC-SHA-256(refreshKey, "refresh-v2" | session id | generation)` with
  `refreshKey = HMAC-SHA-256(ULTRA_AUTH_SECRET, "ultra-refresh-token-v2")`. The session
  row stores the current generation and the time of the last refresh
  (`ultra_sessions.refresh_generation`, `refreshed_at`). Nothing is stored per refresh: a
  session that refreshes about every nine minutes (roughly 58,000 times a year) holds one
  counter, and no token or digest of a version 2 token is stored anywhere.
- **Rotation.** The MAC is verified in constant time **before any database access**, so a
  forged, truncated or foreign token is a generic `401` that reads and writes nothing and
  can never revoke a session. For a genuine token the session row is locked and the
  token's generation is compared with the stored one. Equal rotates the session
  (generation + 1, idle window slid, `refreshed_at` set). **Lower is reuse** and revokes
  the whole session (the revocation is committed and the answer is `401`). Higher is a
  generic `401` that leaves the session alone, because the server never issued it.
  Replay detection therefore covers **every** earlier generation, however many rotations
  have happened since: a thief who refreshes a stolen session a hundred times does not
  hide the owner's later replay of the original token.
- **Tokens issued before this release** (43 random characters, one stored receipt per
  refresh) are still accepted. Their first refresh locks the session, then the receipt: an
  unused receipt is consumed and the session moves to generation 0 (from then on it holds
  version 2 tokens only), a consumed one revokes the session exactly as before. A legacy
  token never resets the counter of a session that already holds generations. The old
  receipt rows are deleted with their session.
- **Locking.** A refresh locks the session row first (and, for a legacy token, then its
  receipt), so two refreshes of one session queue instead of deadlocking. Every security
  change locks the account, then the challenge, then the session (account deletion
  follows the same order).
- **Activity** (the unused-session rule of the 30-session cap, device recognition and the
  sessions list) is `GREATEST(created_at, refreshed_at)` of the session. Sessions that
  existed before the migration have `refreshed_at = 0` until their first refresh, so until
  then they count as active only since they were created.

### Reuse revocation and the lost-response case (known limitation)

Single-use rotation is kept exactly. Presenting a refresh token that was already
consumed, **of any earlier generation**, **revokes the whole session**, with no leeway
window. Regression tests pin this, including the case a pruned history would miss: a
thief who rotates a stolen session many times and then the owner's replay of the first
token.

The consequence is a known, accepted limitation: if the server rotates a token but
the response never reaches the client (network drop or sleep between commit and
receipt), the client's retry presents a consumed token and the session is revoked. The
client must treat a refresh `401` as "sign in again" and show a persistent reconnect
state; it must not loop. It must also persist each rotated refresh token before using
it, and serialize refreshes (the SDK does both).

A safe improvement would be an idempotent retry bound to a client secret (for example
the server remembers the last rotation result for a short time, redeemable only by a
caller that proves it holds a per-session secret). That changes the security model of
the refresh credential and is **not implemented**; it needs its own security review
before anyone relaxes reuse detection.

## Configuration

| Variable                          | Default | Meaning                                                                                                                         |
| --------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `ULTRA_DEVICE_EMAIL_VERIFICATION` | `true`  | `false` is the operator kill switch. `true` also needs SMTP configured. Any other value stops the server at startup             |
| `ULTRA_SESSION_IDLE_DAYS`         | `180`   | Whole days, 1 to 3650. Also the window inside which a device counts as recently active                                          |
| `ULTRA_SESSION_MAX_DAYS`          | `1095`  | Whole days, 1 to 36500; `0` means no absolute cap. A non-zero value below `ULTRA_SESSION_IDLE_DAYS` stops the server at startup |

Environment changes need a restart. Lowering the idle window affects a session at its
next refresh; stored expiry values are not rewritten. `ULTRA_AUTH_SECRET` also keys the
refresh-token MAC, so changing it (which the supported update and hostname-change
procedures never do) makes every outstanding refresh token fail with `401` and every user
signs in again.

## Rollout, kill switch and rollback

The default is on once the dashboard and clients support the challenge. The server
bundle includes the dashboard, but installed apps update separately. Recommended
staging for an operator that already has beta 1 apps in the field:

1. Take and verify a paired backup (`sh scripts/backup.sh`), then update with the
   supported command. The migration (`20261118000000_account_devices_sessions`) runs
   before the new server starts. It is additive and fast.
2. Start with `ULTRA_DEVICE_EMAIL_VERIFICATION=false`. Sliding sessions and the
   dashboard changes are active; nobody is challenged, no device tokens are issued and
   old clients are unaffected.
3. Ship the application and SDK `0.1.5` clients. Confirm in `/capabilities` that the
   flag is reported and that a test account completes the code step and a recognized
   second sign-in without a new email.
4. Set `ULTRA_DEVICE_EMAIL_VERIFICATION=true` and restart. Beta 1 applications that
   sign in on a new device now see "Update Ultra Tasks to sign in on a new device."
   Their existing sessions keep working.
5. **Kill switch**: set the variable to `false` and restart. Challenges stop at once;
   pending challenges simply expire. No data changes. Use it for an SMTP outage that
   must not block sign-in. While off, no new device tokens are issued.

Leaving the default on while beta 1 applications are installed makes their
new-device sign-ins fail with the update message; that is the intended fail-closed
behavior, but it is a visible change for those users, so stage it as above.

Rollback:

- **Behavior**: set the flag to `false`. This is instant (one restart) and lossless.
- **Image**: redeploy the previous image. The migration is additive: the old binary never
  reads `new_device_email`, `ultra_devices`, `device_id`, `refresh_generation` or
  `refreshed_at` and keeps working, with **one exception: refresh tokens**. It accepts
  only the 43-character form, so a session that holds a 48-character token (every session
  issued by this release, and every older one that has refreshed since the update) is
  answered `400` at its next refresh and its owner signs in again. A session that has not
  refreshed since the update still holds its original token and carries on. The old binary
  writes a 30-day idle expiry on refresh, while sessions issued by this release keep their
  stored (longer) expiry until then. Moving forward again needs nothing: sessions created
  under the old binary have no generation and migrate at their first refresh.
- **After a rollback, before upgrading again**: the old binary does not delete devices
  when a password is changed or an account is recovered, nor delete pending
  `device-email` challenges. If either happened during the rollback window, forget all
  device trust once so those accounts are re-verified on their next sign-in:
  `DELETE FROM "ultra_devices";` (one email per device, no data loss, sessions stay and
  merely become unbound). Do not flag the `revoked` column for this: nothing reads it.
- **Schema**: leave it in place. If it must be removed, first make sure no new server
  is running, then (as a database administrator, after a backup):

```sql
ALTER TABLE "ultra_sessions" DROP COLUMN "refreshed_at";
ALTER TABLE "ultra_sessions" DROP COLUMN "refresh_generation";
ALTER TABLE "ultra_sessions" DROP COLUMN "device_id";
DROP TABLE "ultra_devices";
ALTER TABLE "ultra_accounts" DROP COLUMN "new_device_email";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261118000000_account_devices_sessions';
```

Restoring a pre-update backup into a fresh installation, as `deploy/README.md`
describes, also removes the schema; sessions and devices created since the backup are
lost, so every user signs in again.

Operator notes: the device label is user-chosen text and is stored; no IP address,
user agent or fingerprint is stored. Device rows and challenge HMACs are included in
database backups and are deleted with the account. Include "device name" in the
privacy notice's list of account data.

## Decisions that go beyond, or differ from, the shared contract

These were made while implementing and are listed so a reviewer can overrule them:

- **Device trust expires with inactivity** (the idle window), instead of never. The
  contract left trusted-device expiry open; this keeps a lost or abandoned token from
  waiving the check forever.
- **Overflow rule for the live-session cap** (above): stale sessions are retired
  instead of refusing, because a flat refusal at 30 locks users out when sessions live
  180 days.
- **Per-account email bound** (12 per hour): an abuse control the contract left
  open.
- **Disabling the setting needs the factor code, enabling does not.** The contract
  asks for a code "when factors are enrolled"; enabling is the safe direction, so a code
  is accepted but not required.
- **`deviceToken` is returned only when newly issued**, never echoed for a recognized
  device, and no device is recorded while the feature is globally off.
- **Browser sign-in redemption** accepts the new keys on `/browser-login/poll` (declared
  support), rather than always returning a token to every app.
- **`PUT /profile` ignores** `username` and `displayName` when they are sent, as the
  contract says; unknown keys are still refused.
- The SDK refreshes capabilities older than ten minutes before signing in, retries once
  after a stale-capability `426`, and keeps a newly issued device token before it unlocks
  the vault.
- **Generation refresh tokens instead of stored receipts.** The first implementation kept
  the eight most recent consumed receipts per session. An independent review showed that
  this was weaker than the previous release: a thief who rotated a stolen session nine
  times made the owner's replay harmless. The token now carries its generation and a MAC,
  the session row holds the counter and a replay of any earlier generation revokes. The
  plan to add a `created_at` column to `ultra_refresh_tokens` was dropped with the receipts.
- **Removing a device deletes it** (the `revoked` flag is unused), and removing a device
  other than the caller's own needs a recent sign-in and, with a factor enrolled, the MFA
  code. The contract did not ask for this. It keeps a stolen refresh session from emptying
  the owner's device list.
- **Turning the setting back on forgets every other device.** This departs from the
  contract's "recognized devices stay trusted": trust minted while the check was off should
  not survive its being switched back on.
- **Pending challenges are capped at the email budget** (12), so none is evicted, and a
  password change or recovery clears the budget.
- **Housekeeping bounds.** Revoked sessions are deleted 30 days after their last activity,
  `GET /sessions` returns at most 100 rows and lapsed device records are deleted when a
  session is next issued for the account.
- **Startup check.** A non-zero `ULTRA_SESSION_MAX_DAYS` shorter than
  `ULTRA_SESSION_IDLE_DAYS` stops the server with a message, because the absolute cap would
  silently override the idle window.

## Verification

Unit and route coverage uses real PostgreSQL SQL in PGlite and the real SDK
cryptography. Test names state the behavior they pin; the main files are:

- `apps/server/tests/ultra-devices.spec.ts`: challenge issue, verify, replay, expiry,
  five-attempt lock, resend cooldown, cap and attempt carry-over, cross-account codes
  and tokens, opt-out and re-enable (and the forgetting of other devices when the check
  is turned back on), recent sign-in and MFA for the setting and for removing another
  device (a device may always remove itself), MFA precedence, the second-factor re-check
  when a code is verified or resent, email change, password change and recovery
  (including the cleared email budget), SMTP failure on sign-in and resend, removal by
  deletion, device cap and least-recently-active pruning, lapsed devices purged, a
  recognized device never renamed, activity from refreshes, label cleaning, account
  deletion, session-cap interaction, strict bodies, the per-account email bound and the
  pending-challenge limit (nothing is evicted), idle-window trust, kill switch and route
  rate limit; browser approval by a trusted and an untrusted session; SDK 0.1.4 request
  shapes (426, MFA, browser redemption, strict bodies). Core flow tests run on both
  authentication engines.
- `apps/server/tests/ultra-devices-webauthn.spec.ts`: pending email challenges are
  deleted when a WebAuthn factor is enrolled (only the WebAuthn registration check is
  mocked).
- `apps/server/tests/ultra-sessions.spec.ts`: sliding renewal past 90 days with an
  advanced clock, idle expiry, absolute cap, zero cap, operator idle window, legacy
  sessions, refresh never renewing `auth_at`; generation tokens that store nothing, a
  thief rotating a stolen session many times and the owner's replay (revokes), the replay
  of any older generation, forged, foreign and future-generation tokens that touch
  nothing, wrong-length tokens, a legacy token that migrates once, whose replay revokes
  and that cannot reset a counter, the lost-response case, the 30-session cap and
  stale-session retirement, the purge of revoked sessions and the 100-row session list.
- `apps/server/tests/ultra-config.spec.ts` (including an absolute cap shorter than the
  idle window), `email.spec.ts`, `migration-sql.spec.ts`, `ultra-accounts.spec.ts`
  (identity, and rotation storing no receipt), and
  `packages/account-crypto/tests/device-verification.spec.ts`.

Every fix of the second review was also broken on purpose, one at a time (19 mutations),
and the test written for it had to fail: refresh reuse not revoked, MAC not checked, a
future generation accepted, a legacy token resetting a counter, legacy reuse not revoked,
pending limit back to 5, budget kept on password change, removal of another device
unguarded, revoked sessions never purged, unbounded session list, opt-back-in keeping
other devices, a sign-in renaming a recognized device, a device flagged instead of
deleted, lapsed devices never purged, verify and resend without the second-factor
re-check, enrolment of TOTP or WebAuthn without the cleanup of pending challenges, and a
cap shorter than the idle window. Every mutation made its tests fail, and the source
files were then compared byte for byte with their backups.

Results of the last run (November 18, 2026, Windows host, PGlite): `npm run build:packages`
succeeded. `npm run test:crypto` 6 files / 32 tests passed. `npm run test:native`
(including its `tsc -p tsconfig.ultra-tests.json` step) 13 files / 171 tests passed on the
default engine. The account specs with `ULTRA_TEST_AUTH_ENGINE=better-auth` (accounts,
devices, devices-webauthn, sessions, browser login, Better Auth, configuration) 7 files /
131 tests passed. `migration-sql`, `migration-status`, `email` and `ultra-config` 4 files /
51 tests passed. Typechecks of the server, its test project, the SDK and the dashboard
(`npx tsc --noEmit -p apps/account`) are clean. The whole inherited server suite
(`vitest run` in `apps/server`) passed 1,555 tests (48 skipped). Its 105 failures are
98 Windows-host tests of shell scripts, file modes and symlinks that this work does not
touch (`health-alert-script` 96, `backup-script` 1, `legal-pages` 1) and 7 tests in local
scratch specs that are not part of the repository: five reproduce the defects of the
second review by asserting the old behavior and now fail as intended, two are unrelated
local probes.

Not run in this work (no Docker or PostgreSQL on the build host): real PostgreSQL
integration (including the `better-auth-refresh.integration.spec.ts` suite, whose
fixture was updated for generation tokens and the new migration but could not be run),
concurrent refresh, verify and revoke races across connections, and published-image
installation and upgrade acceptance. PGlite serializes statements, so no race claim is
exercised by these tests. These remain release gates.

## Security review and residual risks

Reviewed by the implementer, then by an independent reader of the code, whose findings
are folded in above (cap overflow, per-account email bound, device trust lifetime, lock
order of account deletion, device binding re-read at password change, uniform answer
at the session cap, SDK token-loss and stale-capability cases), then by a second,
adversarial review. Its findings were fixed, and each fix has a test that fails without
it: replay detection that a thief could outrun (now generation tokens), pending-code
eviction, removal of other devices without a recent sign-in, unbounded revoked-session
history and session list, trust that survived an opt-out, device labels rewritten at
sign-in, device rows that were flagged yet still trusted, an absolute cap shorter than
the idle window, and two controls that had no test (the second-factor re-check when a
code is verified or resent, and the deletion of pending challenges when a factor is
enrolled). Properties that hold:

- No path issues a session, a device token or a token echo without a password proof
  followed by a satisfied policy: recognized token, verified code, completed second
  factor, or an approval from a live, recently authenticated session on a trusted device.
- A code allows at most five comparisons per challenge in total; the attempt is counted
  and committed before the comparison and survives the transaction; resend rewrites the
  same row, so neither the budget nor the expiry resets.
- Every device and challenge query is bound to the account. A token or code from another
  account, a revoked or idle device and a replayed code are all the same generic `401`
  or an ordinary unrecognized device.
- Single-use rotation, `requireRecent`, MFA precedence and the 426 refusal of old
  clients are unchanged or enforced as specified. Reuse revocation is as strong as before:
  every earlier generation revokes, however old, and a forged token reads and writes
  nothing.
- Raw SQL is parameterized; the few `Prisma.raw` fragments are fixed constants.

Residual risks and limits, stated plainly:

1. **Email is not a factor.** Mailbox access plus the password defeats it, a live phishing
   relay defeats it, and it adds no protection on a compromised device. The challenge
   response carries a hint (the first character of the address and its domain) that is
   shown to anyone who has proved the password, whether or not they can read the mailbox.
2. **Opt-out is a window of recorded trust.** While the owner is opted out every sign-in
   records a device. Turning the setting back on forgets all of them except the device
   making the change (a departure from the contract, see the decisions), and the others
   are challenged once on their next password sign-in. A password change or recovery
   also resets them, and the dashboard can remove other devices (with a recent sign-in
   and, when a factor is enrolled, the MFA code).
3. **Mail flooding and nuisance by a password holder** are bounded (12 emails an hour per
   account, per-IP route limits) but not impossible. A password holder can spend the
   hourly bound and so block the owner's new-device sign-ins for up to an hour, until the
   owner changes the password or recovers the account (both clear the bound). They cannot
   push a pending code out, because the pending limit equals the bound. Recognized
   devices, sessions in use and recovery are unaffected.
4. **A lost refresh response ends the session** (above). Clients must show a reconnect
   state. The price of detecting a replay of any generation is that an honest retry of a
   lost response is treated like a replay.
5. **Beta 1 orphans**: installed beta 1 apps create a new session at every restart. They
   are cleaned up by the overflow rule once a day passes, but they remain visible in the
   session list and sync-capable until the idle window ends, six times longer than
   before. Revoked sessions are deleted 30 days after their last activity and the list
   shows at most 100 rows. Shipping the clients that restore their session removes the
   cause.
6. **Real-PostgreSQL concurrency is untested here.** The design avoids lock cycles, but
   it has not been exercised across connections: the session-then-receipt order of a
   legacy refresh and the generation compare under the session row lock are reasoned, not
   measured.
7. **A first sign-in after sign-up or recovery asks for a second email code** (the
   account's first device is unrecognized). It is safe but redundant after a code the
   person just typed; a narrow server-side exemption would need its own review.
8. **Device names are user-controlled text.** The server removes control and
   bidirectional characters; every client must still render them as text, never markup.
9. **No independent cryptographic or penetration review** has been done. This document
   is not one.
10. **Browser-approved sessions have a fresh sign-in time.** The session created when an
    app redeems a browser approval gets `auth_at = now`, so that app can change security
    settings (password, factors, email, other devices, the new-device setting) for ten
    minutes without a new password proof, as before this release. The approval itself
    now needs a live session on a trusted device.
11. **WebAuthn-only accounts need a recovery code for two actions.** Disabling the
    new-device check and removing another device ask for an MFA code, which is a TOTP code
    or a recovery code (a recovery code is consumed when used). A security key alone cannot
    answer these requests, so an account with only WebAuthn factors uses a recovery code,
    as it already does when removing a factor or recovering the account.
12. **Mixed flag values during a rolling restart.** Each process reads
    `ULTRA_DEVICE_EMAIL_VERIFICATION` at startup. While processes disagree, a sign-in
    answered by one with the check off is not challenged and records no device, and
    `/capabilities` can alternate between answers (the SDK refetches a stale capability
    and retries once). Treat the setting as in force only after every process has
    restarted. The supported single-container deployment has one process.
13. **Sessions issued while the check was off are unbound.** They have no device record,
    keep syncing and refreshing, and cannot approve a browser sign-in for a new device once
    the check is on, until the person signs in again on that browser.
14. **The password proof is checked outside the account lock.** `/login/finish` verifies
    the OPAQUE proof and consumes the login challenge before the session is issued under
    the account lock, as in the previous release, so a proof accepted just before a
    concurrent password change can still yield a session just after it. The window is one
    request. It is unchanged and not widened by this work.
15. **Sessions that predate the migration have no recorded refresh time** until their
    first refresh (`refreshed_at = 0`), so until then their activity is their creation
    time. This only matters to the unused-session rule at the 30-session cap.
