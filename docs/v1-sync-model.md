# Private account sync for v1

The v1 user model is a normal account: create an account, verify email, sign in on each client, and manage connected devices from `/account`. The account dashboard is a separate browser entry point that can later sit alongside the full Ultra Tasks web application. Task editing in the dashboard and project sharing are outside v1.

## Identity and encryption

Passwords are proven with the existing OPAQUE implementation. The client encrypts its account key vault and personal records before upload. Login unlocks the same account vault on another device; the server stores ciphertext and synchronization metadata rather than task titles or unwrapped keys. The password, printable recovery key, and unwrapped vault keys remain on the client.

Email verification proves control of an address. Email recovery alone cannot decrypt data or replace the encrypted vault: recovery also requires the saved vault recovery key and any required second factor. A password change rewraps the existing keys rather than re-encrypting every task. Device sessions can be revoked from the dashboard. These are inherited protocol behaviors, retained during extraction.

End-to-end encryption does not hide account email, device/session metadata, record sizes, timing, or other routing metadata from the operator. It also does not encrypt the clients' existing local task databases. The browser dashboard is served by the operator, so its delivered code remains part of the trust boundary.

## Private synchronization

Each account uses its personal encrypted scope. Clients persist pending encrypted transactions, upload them with retry identity, fetch changes, decrypt locally, and resolve them with the existing native sync rules. Independent accounts cannot read each other's personal scope. Offline work remains local and uploads after unlocking and reconnecting.

The published server always enables the private profile. Capability discovery reports `scopedSync: true`, `sharedProjects: false`, and `sharedRealtime: false`. It rejects project creation, omits invitations/recipient lookup/ownership transfer/shared sockets, and hides existing non-personal scopes without deleting their stored data. Legacy SuperSync routes are absent. The database migration and encrypted wire format have not changed for extraction.

Personal delivery currently polls every 60 seconds while the client is unlocked. Faster foreground upload/pull scheduling and personal wakeup notifications remain v1 work; the server must remain the source of durable ordering, and notifications must contain no task content. Background mobile behavior must respect each platform's suspension limits.

## Compatibility boundary

Server and native SDK development belong in this repository. The application still uses its retained SDK source until versioned artifacts and compatibility checks are in place. The extracted legacy shared-schema and sync-core packages are frozen bootstrap snapshots, not new independently maintained forks. Existing data requires an explicit migration and write-fencing decision; users must never accidentally write the same dataset through two competing protocols.

See [implementation status](implementation-status.md) for the remaining release gates, and [source provenance](../SOURCE.md) for the extraction baseline.
