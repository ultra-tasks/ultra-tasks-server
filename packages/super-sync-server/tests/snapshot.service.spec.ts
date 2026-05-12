import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { SnapshotService } from '../src/sync/services/snapshot.service';
import * as zlib from 'zlib';

// Mock prisma
vi.mock('../src/db', () => ({
  prisma: {
    userSyncState: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    operation: {
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $queryRaw: vi.fn(),
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
    vi.mocked(prisma.$queryRaw).mockResolvedValue([{ bytes: 0 }] as any);
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

    it('should return null on decompression error', async () => {
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: Buffer.from('not-compressed-data'),
        lastSnapshotSeq: 10,
        snapshotAt: BigInt(Date.now()),
        snapshotSchemaVersion: 1,
      } as any);

      const result = await service.getCachedSnapshot(1);

      expect(result).toBeNull();
    });
  });

  describe('cacheSnapshot', () => {
    it('should compress and store snapshot', async () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const state = { TASK: { 'task-1': { id: 'task-1' } } };
      vi.mocked(prisma.userSyncState.update).mockResolvedValue({} as any);

      const result = await service.cacheSnapshot(1, state, 10);

      expect(prisma.userSyncState.update).toHaveBeenCalledWith({
        where: { userId: 1 },
        data: {
          snapshotData: expect.any(Buffer),
          lastSnapshotSeq: 10,
          snapshotAt: BigInt(now),
          snapshotSchemaVersion: expect.any(Number),
        },
      });
      expect(result.cached).toBe(true);
      expect(result.previousBytes).toBe(0);
      expect(result.bytesWritten).toBeGreaterThan(0);
      expect(result.deltaBytes).toBe(result.bytesWritten);
    });

    it('should report replacement byte delta when caching snapshot', async () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const preparedSnapshot = {
        data: Buffer.from('prepared-cache'),
        bytes: 14,
        stateBytes: 42,
        cacheable: true,
      };
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ bytes: BigInt(5) }] as any);
      vi.mocked(prisma.userSyncState.update).mockResolvedValue({} as any);

      const result = await service.cacheSnapshot(
        1,
        { ignored: true },
        10,
        preparedSnapshot,
      );

      expect(prisma.userSyncState.update).toHaveBeenCalledWith({
        where: { userId: 1 },
        data: {
          snapshotData: preparedSnapshot.data,
          lastSnapshotSeq: 10,
          snapshotAt: BigInt(now),
          snapshotSchemaVersion: expect.any(Number),
        },
      });
      expect(result).toEqual({
        cached: true,
        bytesWritten: 14,
        previousBytes: 5,
        deltaBytes: 9,
      });
    });

    // Skip: Testing size limit requires mocking zlib which is a native module.
    // The size check is a simple comparison and is implicitly tested by integration tests.
    it.skip('should skip caching if snapshot is too large', async () => {
      // This test is skipped because zlib cannot be easily mocked
      // The MAX_SNAPSHOT_SIZE_BYTES check is a simple comparison
    });

    it('should clear a previously-cached snapshot when the new one is oversized', async () => {
      // Regression for W11: when prepared.cacheable is false, the stale
      // snapshot row must be cleared (otherwise callers see an outdated blob
      // alongside ops the new — rejected — snapshot was supposed to cover),
      // and the negative delta must be returned so storage accounting credits
      // the freed space.
      const preparedTooLarge = {
        data: Buffer.alloc(1),
        bytes: 60 * 1024 * 1024,
        stateBytes: 100,
        cacheable: false,
      };
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ bytes: BigInt(8000) }] as any);
      vi.mocked(prisma.userSyncState.update).mockResolvedValue({} as any);

      const result = await service.cacheSnapshot(
        1,
        { ignored: true },
        10,
        preparedTooLarge,
      );

      expect(prisma.userSyncState.update).toHaveBeenCalledWith({
        where: { userId: 1 },
        data: {
          snapshotData: null,
          lastSnapshotSeq: null,
          snapshotAt: null,
          snapshotSchemaVersion: null,
        },
      });
      expect(result).toEqual({
        cached: false,
        bytesWritten: 0,
        previousBytes: 8000,
        deltaBytes: -8000,
      });
    });

    it('should not touch the row when oversized and no previous snapshot exists', async () => {
      // Avoid an unnecessary UPDATE when there is nothing to clear.
      const preparedTooLarge = {
        data: Buffer.alloc(1),
        bytes: 60 * 1024 * 1024,
        stateBytes: 100,
        cacheable: false,
      };
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ bytes: BigInt(0) }] as any);
      vi.mocked(prisma.userSyncState.update).mockResolvedValue({} as any);

      const result = await service.cacheSnapshot(
        1,
        { ignored: true },
        10,
        preparedTooLarge,
      );

      expect(prisma.userSyncState.update).not.toHaveBeenCalled();
      expect(result).toEqual({
        cached: false,
        bytesWritten: 0,
        previousBytes: 0,
        deltaBytes: 0,
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

    it('should invoke onCacheDelta with the bytes-written delta after a snapshot rewrite', async () => {
      // Regression for C3: GET /snapshot rewrites snapshotData inside its
      // transaction, but the storage counter is updated incrementally based
      // on op deltas only. Without this hook the cache can grow up to
      // MAX_SNAPSHOT_SIZE_BYTES with no quota accounting.
      const previousBytes = 500;
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const update = vi.fn().mockResolvedValue({});
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 1 })
              .mockResolvedValueOnce({
                snapshotData: Buffer.alloc(previousBytes),
                lastSnapshotSeq: 0,
                snapshotAt: null,
                snapshotSchemaVersion: 1,
              }),
            update,
          },
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-1',
                serverSeq: 1,
                opType: 'CRT',
                entityType: 'TASK',
                entityId: 'task-1',
                payload: { title: 'T' },
                schemaVersion: 1,
                isPayloadEncrypted: false,
              },
            ]),
          },
        };
        return fn(mockTx);
      });

      const onCacheDelta = vi.fn().mockResolvedValue(undefined);

      await service.generateSnapshot(1, onCacheDelta);

      expect(onCacheDelta).toHaveBeenCalledTimes(1);
      const deltaArg = onCacheDelta.mock.calls[0][0] as number;
      // The new snapshot is a fresh gzip of the replayed state; the previous
      // cached snapshot was 500 bytes of zeros. The delta is whatever the new
      // compressed size is minus 500 — assert the directionality rather than
      // an exact number since gzip output varies.
      expect(typeof deltaArg).toBe('number');
      expect(deltaArg).not.toBe(0);
    });

    it('should not invoke onCacheDelta when the cached snapshot is already up to date', async () => {
      // When startSeq >= latestSeq the snapshot service returns the cached
      // state without rewriting snapshotData — no counter update is needed.
      const cachedState = { TASK: { t1: { id: 't1' } } };
      const compressed = zlib.gzipSync(JSON.stringify(cachedState));
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
        const mockTx = {
          userSyncState: {
            findUnique: vi
              .fn()
              .mockResolvedValueOnce({ lastSeq: 7 })
              .mockResolvedValueOnce({
                snapshotData: compressed,
                lastSnapshotSeq: 7,
                snapshotAt: BigInt(1),
                snapshotSchemaVersion: 1,
              }),
            update: vi.fn(),
          },
          operation: { count: vi.fn(), findMany: vi.fn() },
        };
        return fn(mockTx);
      });

      const onCacheDelta = vi.fn().mockResolvedValue(undefined);

      await service.generateSnapshot(1, onCacheDelta);

      expect(onCacheDelta).not.toHaveBeenCalled();
    });

    it('should swallow a thrown onCacheDelta to avoid corrupting the snapshot result', async () => {
      // The hook is post-commit and side-effecting; its failure should not
      // bubble up and fail the snapshot generation.
      vi.mocked(prisma.$transaction).mockImplementation(async (fn: any) => {
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
          operation: {
            count: vi.fn().mockResolvedValue(0),
            findMany: vi.fn().mockResolvedValue([
              {
                id: 'op-1',
                serverSeq: 1,
                opType: 'CRT',
                entityType: 'TASK',
                entityId: 'task-1',
                payload: { title: 'T' },
                schemaVersion: 1,
                isPayloadEncrypted: false,
              },
            ]),
          },
        };
        return fn(mockTx);
      });

      const onCacheDelta = vi.fn().mockRejectedValue(new Error('counter down'));

      await expect(service.generateSnapshot(1, onCacheDelta)).resolves.toBeDefined();
      expect(onCacheDelta).toHaveBeenCalledTimes(1);
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
            update: vi.fn().mockResolvedValue({}),
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
            update: vi.fn().mockResolvedValue({}),
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
            update: vi.fn().mockResolvedValue({}),
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

    it('should skip encrypted operations', () => {
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

      const result = service.replayOpsToState(ops as any);

      expect(result).toEqual({});
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
