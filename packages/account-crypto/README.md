# Ultra Tasks account encryption

Browser and Node account client, pinned OPAQUE authentication, password/recovery
vault wrappers, HPKE project-key delivery, and signed v2 record primitives.
This package contains no Angular imports or database access. Its server-side
OPAQUE export must not be exposed as an unauthenticated application API.

Build from the repository root with `npm run account-crypto:build`; test with
`npm run quiet -- account-crypto:test`. The build also creates the account portal
bundle under the server's generated `public/ultra-account/` directory. Do not
edit or commit that generated bundle.

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

These are cryptographic primitives, not the complete sharing protocol. Project
membership authorization, owner-signed control history, trusted public-key
distribution, device certification, transactional write manifests, automatic
membership rekeying, and record delivery belong to the following milestones.
Do not accept an arbitrary public key or AEAD ciphertext as proof of project
membership or permission to edit.

The browser integration test exercises the built bundle, real WebAuthn ceremonies
with a virtual authenticator, printable recovery material, and cached offline
unlock. Native Android/iOS background-worker integration and independent security
review remain required before a public v2 sync/collaboration release.

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
See [the maintained protocol and limits](../super-sync-server/docs/native-sync.md).
