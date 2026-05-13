# @sp/sync-core

Framework-agnostic primitives for the Super Productivity sync engine: operation-log types, vector clocks, conflict resolution, gzip compression, and end-to-end encryption. Consumed by the main app and the SuperSync server; no Angular/Electron/Capacitor dependencies.

## Encryption

The encryption layer provides Argon2id key derivation and AES-256-GCM authenticated encryption, with a WebCrypto path and an `@noble/ciphers` fallback for environments where `crypto.subtle` is unavailable (notably Android Capacitor on `http://localhost`).

```ts
import {
  encrypt,
  decrypt,
  encryptBatch,
  decryptBatch,
  clearSessionKeyCache,
  setLegacyKdfWarningHandler,
} from '@sp/sync-core';

const cipher = await encrypt('hello', password);
const plain = await decrypt(cipher, password);
```

### Wire format (public contract)

| Format   | Bytes                                                           |
| -------- | --------------------------------------------------------------- |
| Argon2id | `[SALT (16)] [IV (12)] [AES-GCM ciphertext + auth tag (>= 16)]` |
| Legacy   | `[IV (12)] [AES-GCM ciphertext + auth tag (>= 16)]`             |

All ciphertexts are base64-encoded for transport. The format is discriminated by length: `< 28` bytes is invalid, `< 44` bytes is unambiguously legacy, `>= 44` bytes is treated as Argon2id with a legacy fallback on auth failure. Do not change this without a versioning migration.

### Session key caching

`encrypt`/`decrypt`/`encryptBatch`/`decryptBatch` all share three in-memory caches (encrypt key, decrypt key by salt, legacy PBKDF2 key) that survive across sync cycles. Argon2id derivation is expensive (~500–2000 ms on mobile with the default 64 MiB / 3 iterations); the cache turns repeated syncs from minutes into seconds.

Call `clearSessionKeyCache()` whenever the user changes their password or logs out. Keys live in memory only and are never persisted.

### Legacy-KDF migration

Old data was encrypted with PBKDF2 using the password as its own salt — cryptographically weak. Two complementary mechanisms surface legacy ciphertext:

1. **Structural** — `decryptWithMigration(data, password)` returns a `DecryptResult` with `wasLegacyKdf` and `migratedCiphertext`. Persist `migratedCiphertext` to migrate the record off PBKDF2.
2. **Side-channel** — `setLegacyKdfWarningHandler(fn)` registers a callback fired on every successful legacy decrypt, regardless of which entry point was used. The host throttles user-facing messages (e.g. show a deprecation banner once per session).

### Argon2id parameters

Defaults are OWASP 2023 mobile guidance (parallelism: 1, iterations: 3, memorySize: 64 MiB). Tests can weaken them via `setArgon2ParamsForTesting({ ... })` — this throws when called with `NODE_ENV === 'production'` in Node bundles. Restore defaults by calling with no argument.

## Other exports

- `OpType`, `Operation`, `VectorClock` and friends — op-log primitive types
- `compareVectorClocks`, `mergeVectorClocks`, `limitVectorClockSize` — clock algebra
- `classifyOpAgainstSyncImport` — full-state-import op disposition
- `createSyncFilePrefixHelpers` — host-configured file prefix codec
- `compressWithGzip`, `decompressGzipFromString` — gzip helpers
- `replayOperationBatch`, `applyRemoteOperations` — replay and apply coordinators
- `planRegularOpsAfterFullStateUpload`, `planSnapshotHydration`, etc. — sync planning

See `src/index.ts` for the full barrel and the JSDoc on individual symbols for usage.

## Tests

```bash
npm test           # vitest run, Node WebCrypto + @noble fallback
npm run test:watch # watch mode
npm run build      # tsup → ESM + CJS + .d.ts
```

Browser-context smoke coverage lives in the consuming app at `src/app/op-log/encryption/encryption.browser.spec.ts` (Karma + real Chrome).
