# Private account sync for v1

The v1 user model is a normal account: create an account, verify email, sign in on each client, and manage connected devices from `/account`. The account dashboard is a separate browser entry point that can later sit alongside the full Ultra Tasks web application. Task editing in the dashboard and project sharing are outside v1.

## Identity and encryption

Passwords are proven with the existing OPAQUE implementation. The client encrypts its account key vault and personal records before upload. Login unlocks the same account vault on another device; the server stores ciphertext and synchronization metadata rather than task titles or unwrapped keys. The password, printable recovery key, and unwrapped vault keys remain on the client.

Email verification proves control of an address. Email recovery alone cannot decrypt data or replace the encrypted vault: recovery also requires the saved vault recovery key and any required second factor. A password change rewraps the existing keys rather than re-encrypting every task. Device sessions can be revoked from the dashboard. These are inherited protocol behaviors, retained during extraction.

End-to-end encryption does not hide account email, device/session metadata, record sizes, timing, or other routing metadata from the operator. It also does not encrypt the clients' existing local task databases. The browser dashboard is served by the operator, so its delivered code remains part of the trust boundary.

## Private synchronization

Each account uses its personal encrypted scope. Clients persist pending encrypted transactions, upload them with retry identity, fetch changes, decrypt locally, and resolve them with the existing native sync rules. Independent accounts cannot read each other's personal scope. Offline work remains local and uploads after unlocking and reconnecting.

The published server always enables the private profile. Capability discovery reports `scopedSync: true`, `sharedProjects: false`, and `sharedRealtime: false`. It rejects project creation, omits invitations/recipient lookup/ownership transfer/shared sockets, and hides existing non-personal scopes without deleting their stored data. Legacy SuperSync routes are absent. The database migration and encrypted wire format have not changed for extraction.

While unlocked, persistent local actions schedule a capture within a 500 ms batch window. The application flushes its operation writes before capturing and persists SDK intents before sending. An edit arriving during an upload schedules another pass. Authorized personal-scope notifications trigger the same capture/decrypt/apply pipeline, with no task content in notifications. The application sets a 60-second HTTP safety fallback; resume and reconnect trigger immediate catch-up. Mobile suspension remains subject to platform limits.

Socket tickets are short-lived, single-use, and bound to the live device session. Only the account owner can subscribe to a personal scope. Revoking that device closes its socket. Capability negotiation keeps periodic HTTP behavior with older servers. This does not provide multi-process notification distribution.

## Compatibility boundary

Server, native SDK, and native contract development belong in this repository. The application consumes SDK `0.1.1` and contract `0.1.0` through exact GitHub release URLs. Legacy shared-schema and sync-core are frozen compatibility tarballs; their source ownership remains with the application. See [source provenance](../SOURCE.md) for revisions.

Initial linking uploads this device to an empty account automatically. When the account has data, the user chooses either the local or account copy. The app flushes local operations, saves a recovery point, and drains and disables the previous provider before linking. An owner-authorized replacement stages encrypted batches separately and publishes the complete new generation in one transaction. If account data changes during staging, the replacement fails without changing the live dataset. Older servers can still import into an empty account or use existing account data, but cannot replace a populated account. Operators still need to switch other devices: this server cannot fence an external provider. Installation identities are distinct; reusing an email on another server does not transfer encrypted data.

See [implementation status](implementation-status.md) for the remaining release gates, and [source provenance](../SOURCE.md) for the extraction baseline.
