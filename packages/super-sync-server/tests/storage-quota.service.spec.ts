import { describe, it, expect, beforeEach, vi } from 'vitest';
import { StorageQuotaService } from '../src/sync/services/storage-quota.service';

// Mock prisma
vi.mock('../src/db', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
    user: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    userSyncState: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from '../src/db';

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('StorageQuotaService', () => {
  let service: StorageQuotaService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new StorageQuotaService();
  });

  describe('calculateStorageUsage', () => {
    it('should calculate storage from operations and snapshot', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ total: BigInt(5000) }]);
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: Buffer.alloc(3000),
      } as any);

      const result = await service.calculateStorageUsage(1);

      expect(result).toEqual({
        operationsBytes: 5000,
        snapshotBytes: 3000,
        totalBytes: 8000,
      });
    });

    it('should handle null operation total', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ total: null }]);
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue(null);

      const result = await service.calculateStorageUsage(1);

      expect(result).toEqual({
        operationsBytes: 0,
        snapshotBytes: 0,
        totalBytes: 0,
      });
    });

    it('should handle missing snapshot', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ total: BigInt(1000) }]);
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
      } as any);

      const result = await service.calculateStorageUsage(1);

      expect(result).toEqual({
        operationsBytes: 1000,
        snapshotBytes: 0,
        totalBytes: 1000,
      });
    });

    it('should avoid materializing JSON payloads as text', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ total: BigInt(1000) }]);
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
      } as any);

      await service.calculateStorageUsage(1);

      const [queryParts] = vi.mocked(prisma.$queryRaw).mock.calls[0] as unknown as [
        TemplateStringsArray,
        number,
      ];
      const query = Array.from(queryParts).join('');

      expect(query).toContain('pg_column_size(payload)');
      expect(query).toContain('pg_column_size(vector_clock)');
      expect(query).not.toContain('payload::text');
      expect(query).not.toContain('vector_clock::text');
    });
  });

  describe('checkStorageQuota', () => {
    it('should allow upload when under quota', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        storageQuotaBytes: BigInt(100000),
        storageUsedBytes: BigInt(50000),
      } as any);

      const result = await service.checkStorageQuota(1, 10000);

      expect(result).toEqual({
        allowed: true,
        currentUsage: 50000,
        quota: 100000,
      });
    });

    it('should deny upload when over quota', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        storageQuotaBytes: BigInt(100000),
        storageUsedBytes: BigInt(95000),
      } as any);

      const result = await service.checkStorageQuota(1, 10000);

      expect(result).toEqual({
        allowed: false,
        currentUsage: 95000,
        quota: 100000,
      });
    });

    it('should use default quota when user has none set', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        storageQuotaBytes: null,
        storageUsedBytes: BigInt(0),
      } as any);

      const result = await service.checkStorageQuota(1, 1000);

      expect(result.quota).toBe(100 * 1024 * 1024); // Default 100MB
      expect(result.allowed).toBe(true);
    });

    it('should handle missing user', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await service.checkStorageQuota(1, 1000);

      expect(result).toEqual({
        allowed: true,
        currentUsage: 0,
        quota: 100 * 1024 * 1024,
      });
    });
  });

  describe('updateStorageUsage', () => {
    it('should update storage usage from calculated total', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ total: BigInt(75000) }]);
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: Buffer.alloc(25000),
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      await service.updateStorageUsage(1);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { storageUsedBytes: BigInt(100000) },
      });
    });

    it('should dedupe concurrent reconciles for the same user', async () => {
      // Simulate a slow SUM(pg_column_size) scan so concurrent callers
      // overlap on the in-flight promise.
      let releaseScan: (value: [{ total: bigint }]) => void = () => undefined;
      vi.mocked(prisma.$queryRaw).mockReturnValueOnce(
        new Promise((resolve) => {
          releaseScan = resolve;
        }) as any,
      );
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      const first = service.updateStorageUsage(1);
      const second = service.updateStorageUsage(1);
      const third = service.updateStorageUsage(1);

      releaseScan([{ total: BigInt(123) }]);
      await Promise.all([first, second, third]);

      // Only one scan + one write should have run for three concurrent calls.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledTimes(1);
    });

    it('should re-scan on a subsequent sequential call after the lock clears', async () => {
      vi.mocked(prisma.$queryRaw).mockResolvedValue([{ total: BigInt(10) }]);
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      await service.updateStorageUsage(1);
      await service.updateStorageUsage(1);

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      expect(prisma.user.update).toHaveBeenCalledTimes(2);
    });

    it('should release the lock when the scan throws', async () => {
      vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error('db down'));
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
      } as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      await expect(service.updateStorageUsage(1)).rejects.toThrow('db down');

      // Lock must be cleared so the next call retries the scan rather than
      // returning the rejected promise forever.
      vi.mocked(prisma.$queryRaw).mockResolvedValueOnce([{ total: BigInt(0) }]);
      await expect(service.updateStorageUsage(1)).resolves.toBeUndefined();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('should wait for an active storage mutation window before exact reconcile', async () => {
      const events: string[] = [];
      let releaseWindow: () => void = () => undefined;

      const activeWindow = service.runWithStorageUsageLock(1, async () => {
        events.push('upload-start');
        await new Promise<void>((resolve) => {
          releaseWindow = resolve;
        });
        events.push('upload-end');
      });
      await flushPromises();

      vi.mocked(prisma.$queryRaw).mockImplementation(async () => {
        events.push('scan');
        return [{ total: BigInt(123) }];
      });
      vi.mocked(prisma.userSyncState.findUnique).mockResolvedValue({
        snapshotData: null,
      } as any);
      vi.mocked(prisma.user.update).mockImplementation(async () => {
        events.push('write');
        return {} as any;
      });

      const reconcile = service.updateStorageUsage(1);
      await flushPromises();

      expect(events).toEqual(['upload-start']);
      releaseWindow();
      await Promise.all([activeWindow, reconcile]);
      expect(events).toEqual(['upload-start', 'upload-end', 'scan', 'write']);
    });
  });

  describe('runWithStorageUsageLock', () => {
    it('should serialize callbacks for the same user', async () => {
      const events: string[] = [];
      let releaseFirst: () => void = () => undefined;

      const first = service.runWithStorageUsageLock(1, async () => {
        events.push('first-start');
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        events.push('first-end');
        return 'first';
      });
      await flushPromises();

      const second = service.runWithStorageUsageLock(1, async () => {
        events.push('second-start');
        return 'second';
      });
      await flushPromises();

      expect(events).toEqual(['first-start']);
      releaseFirst();
      await expect(Promise.all([first, second])).resolves.toEqual(['first', 'second']);
      expect(events).toEqual(['first-start', 'first-end', 'second-start']);
    });

    it('should allow nested callbacks for the same user', async () => {
      const result = await service.runWithStorageUsageLock(1, () =>
        service.runWithStorageUsageLock(1, async () => 'nested'),
      );

      expect(result).toBe('nested');
    });
  });

  describe('clearForUser', () => {
    it('should not throw when no lock exists', () => {
      expect(() => service.clearForUser(42)).not.toThrow();
    });
  });

  describe('incrementStorageUsage', () => {
    it('should atomically increment storage_used_bytes', async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      await service.incrementStorageUsage(1, 4096);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { storageUsedBytes: { increment: BigInt(4096) } },
      });
    });

    it('should floor non-integer deltas', async () => {
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      await service.incrementStorageUsage(1, 4096.9);

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: 1 },
        data: { storageUsedBytes: { increment: BigInt(4096) } },
      });
    });

    it.each([0, -1, NaN, Infinity, -Infinity])(
      'should be a no-op for non-positive or non-finite delta %p',
      async (delta) => {
        vi.mocked(prisma.user.update).mockResolvedValue({} as any);

        await service.incrementStorageUsage(1, delta);

        expect(prisma.user.update).not.toHaveBeenCalled();
      },
    );
  });

  describe('decrementStorageUsage', () => {
    it('should run a clamped UPDATE via $executeRaw', async () => {
      vi.mocked(prisma.$executeRaw).mockResolvedValue(1 as any);

      await service.decrementStorageUsage(1, 2048);

      expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(prisma.$executeRaw).mock.calls[0];
      // First arg is the tagged template TemplateStringsArray; subsequent args
      // are the interpolated values (delta BigInt + userId).
      const interpolatedValues = callArgs.slice(1);
      expect(interpolatedValues).toContain(BigInt(2048));
      expect(interpolatedValues).toContain(1);
    });

    it.each([0, -1, NaN, Infinity])(
      'should be a no-op for non-positive or non-finite delta %p',
      async (delta) => {
        vi.mocked(prisma.$executeRaw).mockResolvedValue(0 as any);

        await service.decrementStorageUsage(1, delta);

        expect(prisma.$executeRaw).not.toHaveBeenCalled();
      },
    );
  });

  describe('getStorageInfo', () => {
    it('should return storage info for user', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        storageQuotaBytes: BigInt(200000000),
        storageUsedBytes: BigInt(50000000),
      } as any);

      const result = await service.getStorageInfo(1);

      expect(result).toEqual({
        storageUsedBytes: 50000000,
        storageQuotaBytes: 200000000,
      });
    });

    it('should use defaults for missing user', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      const result = await service.getStorageInfo(1);

      expect(result).toEqual({
        storageUsedBytes: 0,
        storageQuotaBytes: 100 * 1024 * 1024,
      });
    });
  });
});
