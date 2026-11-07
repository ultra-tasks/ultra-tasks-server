# Source and extraction

This repository was extracted from https://github.com/ultra-tasks/ultra-tasks at commit 535576e7c9643c2763661a3660c946f69e1525e1.

The relevant history contains 765 commits. The last filtered commit before the layout change is `5810290be5479dc2c7da0660e6239b4cf3b4a99f`. Filtering changes commit IDs; authors, dates, messages, and relevant file histories are retained. The original client repository history is unchanged.

The server, account SDK, legacy shared-schema, legacy sync-core, server workflows, and license history were included. Original Super Productivity MIT grants and notices remain in LICENSES/ and the server package. Ultra Tasks additions use AGPL-3.0-only.

The sync-core and shared-schema source snapshots are bootstrap compatibility dependencies, pinned to the extraction baseline. Their ongoing legacy ownership remains with the client repository; they must become versioned compatibility artifacts rather than independently evolving copies. Native SDK and server changes belong here after the client package cutover.
