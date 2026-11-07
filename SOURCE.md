# Source and extraction

This repository was extracted from https://github.com/ultra-tasks/ultra-tasks at commit 535576e7c9643c2763661a3660c946f69e1525e1.

The relevant history contains 765 commits. The last filtered commit before the layout change is `5810290be5479dc2c7da0660e6239b4cf3b4a99f`. Filtering changes commit IDs; authors, dates, messages, and relevant file histories are retained. The original client repository history is unchanged.

The server, account SDK, legacy shared-schema, legacy sync-core, server workflows, and license history were included. Original Super Productivity MIT grants and notices remain in LICENSES/ and the server package. Ultra Tasks additions use AGPL-3.0-only.

The duplicate legacy package source has been removed. Server dependencies are frozen release artifacts: shared-schema from client `535576e7c9643c2763661a3660c946f69e1525e1` (`legacy-compat-535576e`), and sync-core from client `64e72f94d9` (`legacy-compat-64e72f9`, including the client's subsequent conflict-resolution fixes). Their ongoing source ownership remains with the application repository. MIT/AGPL notices are included in the tarballs.

Native contracts are unchanged wire-v2 schemas in `packages/sync-contract`, published as `@ultra-tasks/sync-contract@0.1.0`. The SDK is `@ultra-tasks/account-crypto@0.1.1`. Exact tarballs are attached to `sdk-v0.1.1`; the application lockfile records integrity hashes and consumes the SDK through `@sp/sync-providers/ultra-tasks`. Publishing a version does not certify a stable server release.
