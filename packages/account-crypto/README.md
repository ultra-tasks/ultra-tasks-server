# Ultra Tasks account encryption

Browser and Node account client, pinned OPAQUE authentication, password/recovery
vault wrappers, HPKE project-key delivery, and signed v2 record primitives.
SDK 0.1.2 also provides [encrypted browser-to-app login](../../docs/browser-login.md),
with proof-bound single-use redemption and an HPKE vault-key grant. It remains
compatible with existing account vaults and the direct password/MFA APIs.
This package contains no Angular imports or database access. Its server-side
OPAQUE export must not be exposed as an unauthenticated application API.

Build from the repository root with `npm run quiet -- build:packages`; test with
`npm run quiet -- test:crypto`. The account dashboard is a separate workspace
under `apps/account`, built with `npm run quiet -- build:dashboard`; its generated
assets are not part of this SDK package.

- OPAQUE: `@serenity-kit/opaque` 1.1.0, RFC 9807, fixed memory-constrained KSF.
- Vault unlock: Argon2id, 64 MiB, three iterations, parallelism one, random salt.
- Vault/content encryption: AES-256-GCM with random 96-bit nonces and context AAD.
- Project key delivery: `@hpke/core` 1.10.0, P-256/HKDF-SHA256/AES-256-GCM.
- Record and recovery proof signatures: ECDSA P-256/SHA-256, canonical JSON.
- Recovery: 256 random bits, encoded as a grouped printable UTRK1 key. The key
  decrypts an alternate account-key wrapper; it is never transmitted to the server.

The KDF and envelope versions are fixed contracts; unrecognized parameters fail
closed. Password changes replace the password wrapper without changing content
keys or invalidating the existing recovery key. Root keys exist only in client
memory while unlocked. The portal caches wrapped vaults and encrypted refresh
credentials in IndexedDB, scoped by origin, server ID, and account ID.

The package also authenticates owner-signed membership grants, account-certified
devices, complete transaction manifests, and ownership-transfer proof chains.
`RealtimeSync` schedules durable shared intents independently of periodic personal
sync, uses scoped one-use socket tickets, and falls back to HTTP. Identical
verified control values use bounded caches; new values are always verified.

The browser suite exercises real virtual WebAuthn, printable recovery, cached
offline unlock, and custom-origin/native browser approval with device-only proof.
`nativeScopeCredentials` emits a narrow read-only key profile for the Android
reminder worker; no password, master key, or account private key leaves the vault.
Native session refresh has one owner shared with foreground/background callers.
Native interoperability fixtures come from this package's real encryption and
signing functions. Production platform/security acceptance remains a release gate.

The package also provides `SyncClient`, encrypted IndexedDB state storage,
personal model codecs, shared-task field validation, and three-way merging.
A client persists intents and the exact signed/encrypted in-flight transaction
before sending it, retries uncertain writes verbatim, and preserves overlapping
edits as private conflict drafts. The browser host holds one native workspace
lease while unlocked. The local account/session cache and sync state are bound
to the account and server; no password or unwrapped key is persisted there.

`personalRecords` covers the complete legacy model inventory, including archives,
settings, reminders, integrations, and opaque plugin documents. Time accrual and
corrections use separate device buckets. Shared project records use an explicit
field allowlist; private overlays remain in the personal scope.
See [the private v1 profile](../../docs/v1-sync-model.md) and
[the protocol and limits](../../apps/server/docs/native-sync.md).
