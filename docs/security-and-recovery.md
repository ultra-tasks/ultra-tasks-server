# Security, recovery, and release acceptance

This record separates implementation evidence from the independent review and production staging still required for stable server 1.0.0. Test accounts, mail, and records are disposable. No test output contains account credentials, recovery material, or task content.

## Automated evidence (November 7, 2026)

- Client full suite: shared core 293, schema 98, providers 467; Angular 19,177 Berlin and 6,517 LA tests passed. After the review's idle-poll adjustment, the focused native service 4 tests and the two-real-Angular-client private test passed again.
- Extracted server native suite 41 and SDK 15 passed. Coverage includes opaque login failures/replays, verification, password rewrap, refresh reuse, MFA/recovery, session revocation, cross-account access, signed records, exact uncertain retries, private-only routes, and personal socket authorization/revocation.
- Inherited server regression suite: 1,483 passed. Its 48 skipped legacy PostgreSQL tests are not counted as validation; native production acceptance uses the separate real-PostgreSQL Docker drill. Cross-repository parity and Angular browser tests have explicit jobs rather than a hidden neighboring-checkout dependency.
- Account browser acceptance 3 passed, including account signup/unlock/recovery, browser MFA handoff, and confirmed deletion. The dashboard was visually inspected.
- Native contract source moved without changing protocol 2 or encrypted formats; the client's schema compatibility suite passed. Cross-repository legacy transport parity 47 tests passed using the actual client test port and extracted server.
- Production dependency audit reports zero vulnerabilities after compatible locked updates. This is dependency evidence, not a cryptographic audit.
- A real CLI regression reproduced arbitrary server environment keys entering generated client JavaScript. The client generator now exports only declared public build keys; the synthetic mixed-env test passed. Backend secrets must live in the server configuration, never the website/client build environment.

## Real PostgreSQL observations

The local AMD64 Docker drill used PostgreSQL 16, independent authenticated SDK devices, actual encrypted transactions, and separate connections. It exercised migration readiness, signup via isolated SMTP, eight devices, concurrent edits, ciphertext quota refusal, paired backup/restore into another empty volume, nonempty restore refusal, and restart/decryption. The final privacy-document drill enables consent and removes the source public document before restore.

The initial capacity run used eight devices, 100 roughly 1 KiB records per device, ten edit rounds, and additional 16 KiB encrypted records until the 32 MiB current-ciphertext quota refused a batch. Pending intents survived reopening. It measured 359 HTTP requests, 35.0 MB request JSON, 806.8 MB response JSON, 250.6 seconds, 8.0 second p95 request time, 337 MiB peak server memory, and database growth from 9.35 MB to 81.9 MB. These are loopback development observations with concurrent host work, not a user-capacity benchmark.

A separate personal-wakeup sample on the small initial scope delivered ten ordinary edits to eight independently authenticated devices with 214 ms p95/p99 SDK convergence. Its subsequent 800-record concurrent workload took 113.2 seconds, with 7.0 second p95 request time and 129.1 MiB peak server memory. SDK latency excludes application bridge capture, WAN delay, and mobile suspension. CI saves fresh aggregate measurements per architecture. AMD64 completed installation/upgrade acceptance; the ARM64 rerun also verifies that the capacity CLI exits after its assertions rather than waiting on idle network/statistics resources. Its default concurrent workload uses five rounds to leave room for the quota drill within the normal request budget.

**Incremental changes (November 11, 2026).** After its first complete download, an SDK 0.1.4 client receives only heads changed since its cursor. The same real-PostgreSQL drill was run twice on fresh stacks from one AMD64 development image: eight devices, 100 roughly 1 KiB records each, five concurrent rounds, then 16 KiB records until the 32 MiB quota refused a batch. Forcing complete downloads (the previous behavior) measured 358 requests, 672.3 MB response JSON, 269.7 seconds, 6.5 second p95 request time and 322.4 MiB peak server memory. With incremental changes: 360 requests, 90.8 MB response JSON, 56.5 seconds, 0.71 second p95 request time and 231.3 MiB peak server memory. Foreground delivery p95 was 317 ms and 342 ms. Both runs converged and retained pending intents after quota refusal. The first incremental attempt was killed by the container's 768 MiB memory limit because the delta query repeated each manifest per head; the shipped query reads each manifest once.

**Release limitation:** a device's first download, any download after a key update, ownership transfer or restore, and the Android background reminder worker still use complete heads. A long-offline device receives all its changes in one response. Restoring a server backup older than a device's synced state makes that device stop with an error until it reconnects; operators should treat such a restore as a re-download for every native client. Do not promise sub-two-second large-account sync or broad hosted capacity from loopback measurements; representative existing-data beta measurements are still required. After each download the app still rebuilds and validates its whole local dataset; measure that before claiming large-account app latency.

## Fresh-context review

A separate agent reviewed the client/server changes and ran native41/41 and SDK 15/15 checks. Fixed findings: five-second idle personal polling (host now uses 60 seconds), omitted legal documents in backup bundles, and restored public-document permissions for container UID 1001. Config/dump files remain private. No additional scoped compatibility or account-isolation finding was reported. This review is not independent specialist cryptographic review.

## Stable-release gates

- Final-revision native AMD64/ARM64 CI, image digests, independently built client integration, and platform CI must pass; workflow definitions alone are insufficient evidence.
- Exercise physical desktop/Android/iOS clients, secure session storage, expiry/refresh, offline/reconnect, reminders, and background suspension. Simulator/CI coverage does not replace this.
- Complete independent authentication, OPAQUE/cryptography, browser/XSS, account recovery, key lifecycle, and cross-account review; resolve release blockers.
- Rehearse migration and retired-provider/device fencing on representative real data, then do a limited beta. The new server cannot remotely stop an unrelated legacy provider.
- Deploy Oracle last: verify architecture/resources, HTTPS/DNS/firewall, real SMTP, public account URLs, enrollment/privacy documents, monitoring, and off-machine protected backups. Restore the actual published image and paired secrets into another machine.
- Public GHCR creation and the server package visibility were approved by the maintainer. Published-image acceptance must verify anonymous pulls and recovery on both architectures.

No stable 1.0.0 tag or production deployment is implied by these automated checks.
