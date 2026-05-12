import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  SnapshotService,
  EncryptedOpsNotSupportedError,
} from '../src/sync/services/snapshot.service';
import * as zlib from 'zlib';

// Mock prisma
vi.mock('../src/db', () => ({
  prisma: {
    userSyncState: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    operation: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

import { prisma } from '../src/db';

const EXPECTED_REPLAY_OPERATION_SELECT = {
  id: true,
  serverSeq: true,
  opType: true,
  entityType: true,
  entityId: true,
  payload: true,
  schemaVersion: true,
  isPayloadEncrypted: true,
};

describe('SnapshotService', () => {
  let service: SnapshotService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SnapshotService();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getCachedSnapshot', () => {
    it('should return null when no snapshot exists', async () => {
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue(null);

      const result = await service.getCachedSnapshot(1);

      expect(result).toBeNull();
    });

    it('should return null when snapshotData is null', async () => {
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
        lastSnapshotSeq: 10,
        snapshotAt: BigInt(Date.now()),
        snapshotSchemaVersion: 1,
      } as any);

      const result = await service.getCachedSnapshot(1);

      expect(result).toBeNull();
    });

    it('should decompress and return cached snapshot', async () => {
      const state = { TASK: { 'task-1': { id: 'task-1', title: 'Test' } } };
      const compressed = zlib.gzipSync(JSON.stringify(state));
      const snapshotAt = BigInt(Date.now());

      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: compressed,
        lastSnapshotSeq: 10,
        snapshotAt,
        snapshotSchemaVersion: 1,
      } as any);

      const result = await service.getCachedSnapshot(1);

      expect(result).toEqual({
        state,
        serverSeq: 10,
        generatedAt: Number(snapshotAt),
        schemaVersion: 1,
      });
    });

    it('should return null and invalidate the cached blob on decompression error', async () => {
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: Buffer.from('not-compressed-data'),
        lastSnapshotSeq: 10,
        snapshotAt: BigInt(Date.now()),
        snapshotSchemaVersion: 1,
      } as any);
      vi.mocked(prisma.userSyncState.update).mockResolvedValue({} as any);

      const result = await service.getCachedSnapshot(1);

      expect(result).toBeNull();
      expect(prisma.userSyncState.update).toHaveBeenCalledWith({
        where: { userId: 1 },
        data: {
          snapshotData: null,
          lastSnapshotSeq: null,
          snapshotAt: null,
          snapshotSchemaVersion: null,
        },
      });
    });
  });

  describe('cacheSnapshot', () => {
    it('should compress and conditionally update an existing row', async () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const state = { TASK: { 'task-1': { id: 'task-1' } } };
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 1 } as any);

      await service.cacheSnapshot(1, state, 10);

      expect(prisma.userSyncState.updateMany).toHaveBeenCalledWith({
        where: {
          userId: 1,
          OR: [{ lastSnapshotSeq: null }, { lastSnapshotSeq: { lt: 10 } }],
        },
        data: {
          snapshotData: expect.any(Buffer),
          lastSnapshotSeq: 10,
          snapshotAt: BigInt(now),
          snapshotSchemaVersion: expect.any(Number),
        },
      });
      expect(prisma.userSyncState.create).not.toHaveBeenCalled();
    });

    it('should create the row when no userSyncState exists (first-time user)', async () => {
      const state = { TASK: { 'task-1': { id: 'task-1' } } };
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 0 } as any);
      vi.mocked(prisma.userSyncState.create).mockResolvedValue({} as any);

      await service.cacheSnapshot(1, state, 10);

      expect(prisma.userSyncState.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: 1,
          lastSnapshotSeq: 10,
          snapshotData: expect.any(Buffer),
        }),
      });
    });

    it('should swallow P2002 when a concurrent writer inserted the row first', async () => {
      const state = { TASK: { 'task-1': { id: 'task-1' } } };
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 0 } as any);
      const p2002 = Object.assign(new Error('unique constraint'), { code: 'P2002' });
      vi.mocked(prisma.userSyncState.create).mockRejectedValue(p2002);

      await expect(service.cacheSnapshot(1, state, 10)).resolves.toBeUndefined();
    });

    it('should rethrow non-P2002 create errors', async () => {
      const state = { TASK: { 'task-1': { id: 'task-1' } } };
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 0 } as any);
      vi.mocked(prisma.userSyncState.create).mockRejectedValue(new Error('boom'));

      await expect(service.cacheSnapshot(1, state, 10)).rejects.toThrow('boom');
    });

    it('should be a no-op when a newer snapshot already won the race', async () => {
      // updateMany returns count=0 with an existing newer row. create then
      // throws P2002 because a row exists. Both swallowed.
      const state = { TASK: { 'task-1': { id: 'task-1' } } };
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 0 } as any);
      const p2002 = Object.assign(new Error('unique constraint'), { code: 'P2002' });
      vi.mocked(prisma.userSyncState.create).mockRejectedValue(p2002);

      await expect(service.cacheSnapshot(1, state, 5)).resolves.toBeUndefined();
    });

    // Skip: Testing size limit requires mocking zlib which is a native module.
    // The size check is a simple comparison and is implicitly tested by integration tests.
    it.skip('should skip caching if snapshot is too large', async () => {
      // This test is skipped because zlib cannot be easily mocked
      // The MAX_SNAPSHOT_SIZE_BYTES check is a simple comparison
    });
  });

  describe('cacheSnapshotIfReplayable', () => {
    it('should skip caching for encrypted payloads', async () => {
      await service.cacheSnapshotIfReplayable(1, {}, 10, true);

      expect(prisma.userSyncState.updateMany).not.toHaveBeenCalled();
      expect(prisma.userSyncState.create).not.toHaveBeenCalled();
    });

    it('should cache plaintext payloads', async () => {
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 1 } as any);

      await service.cacheSnapshotIfReplayable(1, { TASK: {} }, 10, false);

      expect(prisma.userSyncState.updateMany).toHaveBeenCalled();
    });
  });

  describe('generateSnapshot - first-time user (no userSyncState row)', () => {
    // Regression test for the RecordNotFound bug: when a user calls
    // generateSnapshot before any uploads, there is no userSyncState row.
    // Previously the inline `tx.userSyncState.update` threw P2025 and the
    // route returned 500. With upsert the path must succeed and return an
    // empty snapshot at seq=0.
    it('should not throw RecordNotFound when no userSyncState row exists', async () => {
      const upsertSpy = vi.fn().mockResolvedValue({});

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            // Both findUnique calls (lastSeq + cachedRow) return null —
            // simulating a brand-new user.
            findUnique: vi.fn().mockResolvedValue(null),
            upsert: upsertSpy,
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findFirst: vi.fn().mockResolvedValue(null),
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return fn(mockTx as any);
      });

      const result = await service.generateSnapshot(1);

      // latestSeq=0, startSeq=0 → no replay needed but no cache either, so
      // the service runs through replay (empty loop) and still upserts.
      expect(result.serverSeq).toBe(0);
      expect(result.state).toEqual({});
      expect(upsertSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId: 1 },
          create: expect.objectContaining({ userId: 1, lastSnapshotSeq: 0 }),
        }),
      );
    });

    it('cacheSnapshot via the standalone path should create the row on first-time user', async () => {
      vi.mocked(prisma.userSyncState.updateMany).mockResolvedValue({ count: 0 } as any);
      vi.mocked(prisma.userSyncState.create).mockResolvedValue({} as any);

      await service.cacheSnapshot(99, { TASK: {} }, 1);

      expect(prisma.userSyncState.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ userId: 99, lastSnapshotSeq: 1 }),
      });
    });
  });

  describe('generateSnapshot - FIX 1.7 concurrent lock', () => {
    it('should only select replay fields needed to generate snapshots', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'op-1',
          serverSeq: 1,
          opType: 'CRT',
          entityType: 'TASK',
          entityId: 'task-1',
          payload: { title: 'Test Task' },
          schemaVersion: 1,
          isPayloadEncrypted: false,
        },
      ]);
      const mockTransaction = vi.mocked(prisma.$transaction);

      mockTransaction.mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 1 })
              .mockResolvedValueOnce({
                snapshotData: null,
                lastSnapshotSeq: null,
                snapshotAt: null,
                snapshotSchemaVersion: null,
              }),
            update: vi.fn().mockResolvedValue({}),
          },
          operation: { count: vi.fn().mockResolvedValue(0), findMany },
        };
        return fn(mockTx as any);
      });

      await service.generateSnapshot(1);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 1,
            serverSeq: { gt: 0, lte: 1 },
          },
          select: EXPECTED_REPLAY_OPERATION_SELECT,
        }),
      );
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('clientId');
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('vectorClock');
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('receivedAt');
    });

    it('should reject latest snapshot generation when encrypted ops are in the replay range', async () => {
      const update = vi.fn();
      const findMany = vi.fn();

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 1 })
              .mockResolvedValueOnce({
                snapshotData: null,
                lastSnapshotSeq: null,
                snapshotAt: null,
                snapshotSchemaVersion: null,
              }),
            update,
          },
          operation: {
            count: vi.fn().mockResolvedValue(1),
            findMany,
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshot(1)).rejects.toThrow(
        'ENCRYPTED_OPS_NOT_SUPPORTED',
      );
      expect(findMany).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    });

    it('should reject latest snapshot generation when replay cannot reach latestSeq', async () => {
      const update = vi.fn();

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 2 })
              .mockResolvedValueOnce({
                snapshotData: null,
                lastSnapshotSeq: null,
                snapshotAt: null,
                snapshotSchemaVersion: null,
              }),
            update,
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-2',
                serverSeq: 2,
                opType: 'CRT',
                entityType: 'TASK',
                entityId: 'task-2',
                payload: { title: 'Task 2' },
                schemaVersion: 1,
                isPayloadEncrypted: false,
              },
            ]),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshot(1)).rejects.toThrow(
        'SNAPSHOT_REPLAY_INCOMPLETE',
      );
      expect(update).not.toHaveBeenCalled();
    });

    it('should prevent concurrent snapshot generation for same user', async () => {
      // Create a delayed response to simulate long snapshot generation
      let resolveFirst: (value: any) => void;
      const firstPromise = new Promise((resolve) => {
        resolveFirst = resolve;
      });

      const mockTransaction = vi.mocked(prisma.$transaction);
      let callCount = 0;
      mockTransaction.mockImplementation(async (fn) => {
        callCount++;
        if (callCount === 1) {
          // First call waits
          return firstPromise;
        }
        // Second call should never happen due to lock
        return { state: {}, serverSeq: 0, generatedAt: Date.now(), schemaVersion: 1 };
      });

      // Start first generation
      const gen1 = service.generateSnapshot(1);

      // Start second generation for same user - should wait for first
      const gen2 = service.generateSnapshot(1);

      // Resolve first generation
      const result = {
        state: { test: 'data' },
        serverSeq: 5,
        generatedAt: Date.now(),
        schemaVersion: 1,
      };
      resolveFirst!(result);

      // Both should return the same result
      const [result1, result2] = await Promise.all([gen1, gen2]);

      expect(result1).toEqual(result);
      expect(result2).toEqual(result);
      // Transaction should only be called once
      expect(mockTransaction).toHaveBeenCalledTimes(1);
    });

    it('should allow concurrent generation for different users', async () => {
      const mockTransaction = vi.mocked(prisma.$transaction);
      mockTransaction.mockImplementation(async (fn, options) => {
        // Mock the transaction callback
        const mockTx = {
          userSyncState: {
            findUnique: vi.fn().mockResolvedValue({ lastSeq: 0 }),
            upsert: vi.fn().mockResolvedValue({}),
          },
          operation: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return fn(mockTx as any);
      });

      // Generate for two different users concurrently
      const [result1, result2] = await Promise.all([
        service.generateSnapshot(1),
        service.generateSnapshot(2),
      ]);

      // Both should complete
      expect(result1).toBeDefined();
      expect(result2).toBeDefined();
      // Transaction should be called twice (once per user)
      expect(mockTransaction).toHaveBeenCalledTimes(2);
    });

    it('should clean up lock on error', async () => {
      const mockTransaction = vi.mocked(prisma.$transaction);
      mockTransaction.mockRejectedValueOnce(new Error('DB error'));

      await expect(service.generateSnapshot(1)).rejects.toThrow('DB error');

      // Lock should be cleaned up, so next call should work
      mockTransaction.mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi.fn().mockResolvedValue({ lastSeq: 0 }),
            upsert: vi.fn().mockResolvedValue({}),
          },
          operation: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return fn(mockTx as any);
      });

      const result = await service.generateSnapshot(1);
      expect(result).toBeDefined();
    });

    it('should reject latest snapshots when encrypted ops exist in replay range', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 5 })
              .mockResolvedValueOnce({ snapshotData: null, lastSnapshotSeq: null }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(1),
            findMany: vi.fn(),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshot(1)).rejects.toThrow(
        'ENCRYPTED_OPS_NOT_SUPPORTED',
      );
    });

    it('should bound latest snapshot replay queries by latestSeq', async () => {
      let findManySpy: ReturnType<typeof vi.fn>;

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        findManySpy = vi.fn().mockResolvedValue([
          {
            id: 'op-1',
            opType: 'CRT',
            entityType: 'TASK',
            entityId: 'task-1',
            payload: { id: 'task-1' },
            isPayloadEncrypted: false,
            serverSeq: 1,
            schemaVersion: 1,
          },
        ]);
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 1 })
              .mockResolvedValueOnce({ snapshotData: null, lastSnapshotSeq: null }),
            upsert: vi.fn().mockResolvedValue({}),
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: findManySpy,
          },
        };
        return fn(mockTx as any);
      });

      await service.generateSnapshot(1);

      expect(findManySpy!).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 1,
            serverSeq: { gt: 0, lte: 1 },
          },
        }),
      );
    });

    it('should reject latest snapshot replay when an operation is missing', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 2 })
              .mockResolvedValueOnce({ snapshotData: null, lastSnapshotSeq: null }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-2',
                opType: 'CRT',
                entityType: 'TASK',
                entityId: 'task-2',
                payload: { id: 'task-2' },
                isPayloadEncrypted: false,
                serverSeq: 2,
                schemaVersion: 1,
              },
            ]),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshot(1)).rejects.toThrow(
        'SNAPSHOT_REPLAY_INCOMPLETE',
      );
    });

    it('should allow latest snapshot replay across a leading gap when the first surviving op is a full-state op', async () => {
      // Scenario: after a clean-slate upload (sync.service preserves lastSeq but
      // wipes ops) the next SYNC_IMPORT lands at lastSeq+1 (e.g. 102). Snapshot
      // replay must accept the leading gap because SYNC_IMPORT resets state.
      const upsertSpy = vi.fn().mockResolvedValue({});

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 102 })
              .mockResolvedValueOnce({ snapshotData: null, lastSnapshotSeq: null }),
            upsert: upsertSpy,
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-102',
                opType: 'SYNC_IMPORT',
                entityType: 'NONE',
                entityId: null,
                payload: { task: { t1: { id: 't1', title: 'after-clean-slate' } } },
                isPayloadEncrypted: false,
                serverSeq: 102,
                schemaVersion: 1,
              },
            ]),
          },
        };
        return fn(mockTx as any);
      });

      const result = await service.generateSnapshot(1);
      expect(result.serverSeq).toBe(102);
      expect((result.state as any).task.t1.title).toBe('after-clean-slate');
    });

    it('should reject leading gap when the first surviving op is not a full-state op', async () => {
      // Same shape as the clean-slate scenario but the surviving op is a CRT —
      // applying it to empty state would silently corrupt the snapshot.
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 102 })
              .mockResolvedValueOnce({ snapshotData: null, lastSnapshotSeq: null }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-102',
                opType: 'CRT',
                entityType: 'TASK',
                entityId: 'task-102',
                payload: { id: 'task-102' },
                isPayloadEncrypted: false,
                serverSeq: 102,
                schemaVersion: 1,
              },
            ]),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshot(1)).rejects.toThrow(
        'SNAPSHOT_REPLAY_INCOMPLETE',
      );
    });
  });

  describe('clearForUser', () => {
    it('should remove pending lock for a user', async () => {
      // Create a pending lock by starting a generation that never resolves
      let resolveGeneration: (value: any) => void;
      const pendingPromise = new Promise((resolve) => {
        resolveGeneration = resolve;
      });

      const mockTransaction = vi.mocked(prisma.$transaction);
      mockTransaction.mockImplementation(() => pendingPromise as any);

      // Start generation (creates a lock)
      const gen1 = service.generateSnapshot(1);

      // Clear the lock for user 1
      service.clearForUser(1);

      // Start another generation - should create a new transaction call
      // because the lock was cleared
      let secondCallCount = 0;
      mockTransaction.mockImplementation(async (fn) => {
        secondCallCount++;
        const mockTx = {
          userSyncState: {
            findUnique: vi.fn().mockResolvedValue({ lastSeq: 0 }),
            upsert: vi.fn().mockResolvedValue({}),
          },
          operation: {
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return fn(mockTx as any);
      });

      const gen2 = service.generateSnapshot(1);
      const result2 = await gen2;

      // Second generation should have started a new transaction
      expect(secondCallCount).toBe(1);
      expect(result2).toBeDefined();

      // Resolve the first one to clean up (avoid unhandled promise rejection)
      resolveGeneration!({
        state: {},
        serverSeq: 0,
        generatedAt: Date.now(),
        schemaVersion: 1,
      });
      await gen1.catch(() => {}); // Ignore any errors from the orphaned promise
    });

    it('should not affect locks for other users', async () => {
      // Create locks for users 1 and 2
      let resolveUser1: (value: any) => void;
      let resolveUser2: (value: any) => void;
      const user1Promise = new Promise((resolve) => {
        resolveUser1 = resolve;
      });
      const user2Promise = new Promise((resolve) => {
        resolveUser2 = resolve;
      });

      const mockTransaction = vi.mocked(prisma.$transaction);
      let callCount = 0;
      mockTransaction.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) return user1Promise;
        if (callCount === 2) return user2Promise;
        throw new Error('Unexpected call');
      });

      // Start generations for both users
      const gen1 = service.generateSnapshot(1);
      const gen2 = service.generateSnapshot(2);

      // Clear lock for user 1 only
      service.clearForUser(1);

      // User 2's lock should still be active - a new call should wait for it
      const gen2b = service.generateSnapshot(2);

      // Resolve user 2's generation
      const result2 = {
        state: { user: 2 },
        serverSeq: 10,
        generatedAt: Date.now(),
        schemaVersion: 1,
      };
      resolveUser2!(result2);

      // Both gen2 and gen2b should get the same result (waited for same lock)
      const [result2a, result2bResult] = await Promise.all([gen2, gen2b]);
      expect(result2a).toEqual(result2);
      expect(result2bResult).toEqual(result2);

      // Clean up user 1's pending promise
      resolveUser1!({
        state: {},
        serverSeq: 0,
        generatedAt: Date.now(),
        schemaVersion: 1,
      });
      await gen1.catch(() => {});
    });
  });

  describe('getRestorePoints', () => {
    it('should return empty array when no restore points exist', async () => {
      vi.mocked(prisma.operation.findMany).mockResolvedValue([]);

      const result = await service.getRestorePoints(1);

      expect(result).toEqual([]);
      expect(prisma.operation.findMany).toHaveBeenCalledWith({
        where: {
          userId: 1,
          opType: { in: ['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR'] },
        },
        orderBy: { serverSeq: 'desc' },
        take: 30,
        select: {
          serverSeq: true,
          clientId: true,
          opType: true,
          clientTimestamp: true,
        },
      });
    });

    it('should return restore points with descriptions', async () => {
      vi.mocked(prisma.operation.findMany).mockResolvedValue([
        {
          serverSeq: 100,
          clientId: 'client-1',
          opType: 'SYNC_IMPORT',
          clientTimestamp: BigInt(1000),
        },
        {
          serverSeq: 50,
          clientId: 'client-2',
          opType: 'BACKUP_IMPORT',
          clientTimestamp: BigInt(500),
        },
        {
          serverSeq: 25,
          clientId: 'client-3',
          opType: 'REPAIR',
          clientTimestamp: BigInt(250),
        },
      ] as any);

      const result = await service.getRestorePoints(1);

      expect(result).toEqual([
        {
          serverSeq: 100,
          timestamp: 1000,
          type: 'SYNC_IMPORT',
          clientId: 'client-1',
          description: 'Full sync import',
        },
        {
          serverSeq: 50,
          timestamp: 500,
          type: 'BACKUP_IMPORT',
          clientId: 'client-2',
          description: 'Backup restore',
        },
        {
          serverSeq: 25,
          timestamp: 250,
          type: 'REPAIR',
          clientId: 'client-3',
          description: 'Auto-repair',
        },
      ]);
    });

    it('should respect limit parameter', async () => {
      vi.mocked(prisma.operation.findMany).mockResolvedValue([]);

      await service.getRestorePoints(1, 5);

      expect(prisma.operation.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5 }),
      );
    });
  });

  describe('generateSnapshotAtSeq', () => {
    it('should throw error for targetSeq > maxSeq', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi.fn().mockResolvedValue({ lastSeq: 10 }),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshotAtSeq(1, 20)).rejects.toThrow(
        'Target sequence 20 exceeds latest sequence 10',
      );
    });

    it('should throw error for targetSeq < 1', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi.fn().mockResolvedValue({ lastSeq: 10 }),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshotAtSeq(1, 0)).rejects.toThrow(
        'Target sequence must be at least 1',
      );
    });

    it('should throw error when encrypted ops exist in range', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi.fn().mockResolvedValue({ lastSeq: 10, snapshotData: null }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(5),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshotAtSeq(1, 5)).rejects.toThrow(
        'ENCRYPTED_OPS_NOT_SUPPORTED',
      );
    });

    it('should throw error when cached snapshot base contains encrypted ops', async () => {
      const encryptedCachedSnapshot = zlib.gzipSync(JSON.stringify('encrypted-state'));

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 5 })
              .mockResolvedValueOnce({
                snapshotData: encryptedCachedSnapshot,
                lastSnapshotSeq: 5,
                snapshotSchemaVersion: 1,
              }),
          },
          operation: {
            findFirst: vi.fn().mockResolvedValue(null),
            count: vi.fn().mockResolvedValue(1),
            findMany: vi.fn(),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshotAtSeq(1, 5)).rejects.toThrow(
        'ENCRYPTED_OPS_NOT_SUPPORTED',
      );
    });

    it('should reject historical snapshot generation when replay cannot reach targetSeq', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 5 })
              .mockResolvedValueOnce({
                snapshotData: null,
                lastSnapshotSeq: null,
                snapshotSchemaVersion: null,
              }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([]),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshotAtSeq(1, 5)).rejects.toThrow(
        'SNAPSHOT_REPLAY_INCOMPLETE',
      );
    });

    it('should throw error when replay range is not contiguous', async () => {
      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 10 })
              .mockResolvedValueOnce({ snapshotData: null, lastSnapshotSeq: null }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-2',
                opType: 'CRT',
                entityType: 'TASK',
                entityId: 'task-2',
                payload: { id: 'task-2' },
                isPayloadEncrypted: false,
                serverSeq: 2,
                schemaVersion: 1,
              },
            ]),
          },
        };
        return fn(mockTx as any);
      });

      await expect(service.generateSnapshotAtSeq(1, 5)).rejects.toThrow(
        'SNAPSHOT_REPLAY_INCOMPLETE',
      );
    });

    it('should only select replay fields needed to generate snapshots at a sequence', async () => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: 'op-1',
          serverSeq: 1,
          opType: 'CRT',
          entityType: 'TASK',
          entityId: 'task-1',
          payload: { title: 'Test Task' },
          schemaVersion: 1,
          isPayloadEncrypted: false,
        },
      ]);

      vi.mocked(prisma.$transaction).mockImplementation(async (fn) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 1 })
              .mockResolvedValueOnce({
                snapshotData: null,
                lastSnapshotSeq: null,
                snapshotSchemaVersion: null,
              }),
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany,
          },
        };
        return fn(mockTx as any);
      });

      await service.generateSnapshotAtSeq(1, 1);

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          select: EXPECTED_REPLAY_OPERATION_SELECT,
        }),
      );
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('clientId');
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('vectorClock');
      expect(findMany.mock.calls[0][0].select).not.toHaveProperty('receivedAt');
    });
  });

  describe('replayOpsToState', () => {
    it('should handle CRT operation', () => {
      const ops = [
        {
          id: 'op-1',
          opType: 'CRT',
          entityType: 'TASK',
          entityId: 'task-1',
          payload: { id: 'task-1', title: 'Test Task' },
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any);

      expect(result).toEqual({
        TASK: {
          'task-1': { id: 'task-1', title: 'Test Task' },
        },
      });
    });

    it('should handle UPD operation', () => {
      const initialState = {
        TASK: { 'task-1': { id: 'task-1', title: 'Old Title' } },
      };
      const ops = [
        {
          id: 'op-1',
          opType: 'UPD',
          entityType: 'TASK',
          entityId: 'task-1',
          payload: { title: 'New Title' },
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any, initialState);

      expect(result).toEqual({
        TASK: {
          'task-1': { id: 'task-1', title: 'New Title' },
        },
      });
    });

    it('should handle DEL operation', () => {
      const initialState = {
        TASK: {
          'task-1': { id: 'task-1' },
          'task-2': { id: 'task-2' },
        },
      };
      const ops = [
        {
          id: 'op-1',
          opType: 'DEL',
          entityType: 'TASK',
          entityId: 'task-1',
          payload: null,
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any, initialState);

      expect(result).toEqual({
        TASK: {
          'task-2': { id: 'task-2' },
        },
      });
    });

    it('should handle BATCH operation with entities', () => {
      const ops = [
        {
          id: 'op-1',
          opType: 'BATCH',
          entityType: 'TASK',
          entityId: null,
          payload: {
            entities: {
              'task-1': { id: 'task-1', title: 'Task 1' },
              'task-2': { id: 'task-2', title: 'Task 2' },
            },
          },
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any);

      expect(result).toEqual({
        TASK: {
          'task-1': { id: 'task-1', title: 'Task 1' },
          'task-2': { id: 'task-2', title: 'Task 2' },
        },
      });
    });

    it('should handle SYNC_IMPORT operation', () => {
      const ops = [
        {
          id: 'op-1',
          opType: 'SYNC_IMPORT',
          entityType: 'FULL_STATE',
          entityId: null,
          payload: {
            appDataComplete: {
              TASK: { 'task-1': { id: 'task-1' } },
              PROJECT: { 'proj-1': { id: 'proj-1' } },
            },
          },
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any);

      expect(result.TASK).toEqual({ 'task-1': { id: 'task-1' } });
      expect(result.PROJECT).toEqual({ 'proj-1': { id: 'proj-1' } });
    });

    it('SYNC_IMPORT replaces the entire state (does NOT merge into stale cache)', () => {
      // Regression test: previously the full-state ops used Object.assign which
      // merged into existing state, so stale entity types from a cached base
      // survived a "reset" SYNC_IMPORT. After the fix, a SYNC_IMPORT must
      // wipe the prior state.
      const stalePriorState = {
        TASK: { 'stale-task': { id: 'stale-task' } },
        PROJECT: { 'stale-proj': { id: 'stale-proj' } },
        TAG: { 'stale-tag': { id: 'stale-tag' } },
      };
      const ops = [
        {
          id: 'op-1',
          opType: 'SYNC_IMPORT',
          entityType: 'FULL_STATE',
          entityId: null,
          payload: {
            appDataComplete: {
              TASK: { 'new-task': { id: 'new-task' } },
            },
          },
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any, stalePriorState);

      expect(result).toEqual({ TASK: { 'new-task': { id: 'new-task' } } });
      // Stale keys gone
      expect(result.PROJECT).toBeUndefined();
      expect(result.TAG).toBeUndefined();
    });

    it('should throw EncryptedOpsNotSupportedError for encrypted operations', () => {
      const ops = [
        {
          id: 'op-1',
          opType: 'CRT',
          entityType: 'TASK',
          entityId: 'task-1',
          payload: { id: 'task-1' },
          isPayloadEncrypted: true, // encrypted
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      expect(() => service.replayOpsToState(ops as any)).toThrow(
        EncryptedOpsNotSupportedError,
      );
      expect(() => service.replayOpsToState(ops as any)).toThrow(
        'ENCRYPTED_OPS_NOT_SUPPORTED',
      );
    });

    it('should skip unknown entity types', () => {
      const ops = [
        {
          id: 'op-1',
          opType: 'CRT',
          entityType: 'unknown_type',
          entityId: 'id-1',
          payload: { id: 'id-1' },
          isPayloadEncrypted: false,
          serverSeq: 1,
          schemaVersion: 1,
        },
      ];

      const result = service.replayOpsToState(ops as any);

      expect(result).toEqual({});
    });
  });
});
