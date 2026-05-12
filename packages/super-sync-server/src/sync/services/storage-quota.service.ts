/**
 * StorageQuotaService - Handles storage quota calculations and checks
 *
 * Extracted from SyncService for better separation of concerns.
 * This service handles storage usage tracking and quota enforcement.
 *
 * Note: Complex cleanup/freeing operations remain in SyncService as they
 * orchestrate multiple operations including deleting restore points.
 */
import { prisma } from '../../db';

/**
 * Default storage quota per user in bytes (100MB).
 */
const DEFAULT_STORAGE_QUOTA_BYTES = 100 * 1024 * 1024;

export class StorageQuotaService {
  /**
   * Per-user in-flight reconcile promises. When multiple concurrent requests
   * for the same user hit the quota cache-miss path, only the first triggers
   * the slow SUM(pg_column_size) scan; the rest await the same promise. Cap
   * the number of duplicate full-table scans under a retry storm. Sequential
   * calls are unaffected (entry is deleted in `finally` before resolve).
   */
  private inflightReconciles: Map<number, Promise<void>> = new Map();

  /**
   * Calculate actual storage usage for a user by summing on-disk payload sizes.
   *
   * SLOW PATH — DO NOT CALL PER REQUEST. SUM(pg_column_size(payload)) forces
   * PostgreSQL to detoast every payload for the user (TOAST table reads),
   * which on active users takes minutes and saturates disk I/O. Reserved for:
   *   1. Quota-cache reconciliation, run at most once per quota-cleanup event
   *      (rare per user) — see SyncService.freeStorageForUpload.
   *   2. Offline / admin reconciliation scripts.
   * Hot-path tracking uses incrementStorageUsage / decrementStorageUsage with
   * deltas computed locally on the Node side.
   */
  async calculateStorageUsage(userId: number): Promise<{
    operationsBytes: number;
    snapshotBytes: number;
    totalBytes: number;
  }> {
    const opsResult = await prisma.$queryRaw<[{ total: bigint | null }]>`
      SELECT COALESCE(SUM(pg_column_size(payload) + pg_column_size(vector_clock)), 0) as total
      FROM operations WHERE user_id = ${userId}
    `;

    const snapshotResult = await prisma.userSyncState.findUnique({
      where: { userId },
      select: { snapshotData: true },
    });

    const operationsBytes = Number(opsResult[0]?.total ?? 0);
    const snapshotBytes = snapshotResult?.snapshotData?.length ?? 0;
    const totalBytes = operationsBytes + snapshotBytes;

    return {
      operationsBytes,
      snapshotBytes,
      totalBytes,
    };
  }

  /**
   * Atomically add `deltaBytes` to the cached storage usage. Called on every
   * accepted upload with a locally-computed payload size. No table scan.
   * Rejects non-finite / non-positive inputs so `BigInt(...)` never throws.
   */
  async incrementStorageUsage(userId: number, deltaBytes: number): Promise<void> {
    if (!Number.isFinite(deltaBytes) || deltaBytes <= 0) return;
    const delta = BigInt(Math.floor(deltaBytes));
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: { increment: delta } },
    });
  }

  /**
   * Atomically subtract `deltaBytes` from the cached storage usage, clamped to
   * zero. Uses $executeRaw for the GREATEST(...) clamp — Prisma's `decrement`
   * has no underflow guard and the counter is approximate (advisory quota), so
   * the floor protects against negative drift from rough estimates.
   */
  async decrementStorageUsage(userId: number, deltaBytes: number): Promise<void> {
    if (!Number.isFinite(deltaBytes) || deltaBytes <= 0) return;
    const delta = BigInt(Math.floor(deltaBytes));
    await prisma.$executeRaw`
      UPDATE users
      SET storage_used_bytes = GREATEST(storage_used_bytes - ${delta}::bigint, 0::bigint)
      WHERE id = ${userId}
    `;
  }

  /**
   * Check if a user has quota available for additional storage.
   * Uses cached storageUsedBytes for performance.
   */
  async checkStorageQuota(
    userId: number,
    additionalBytes: number,
  ): Promise<{ allowed: boolean; currentUsage: number; quota: number }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { storageQuotaBytes: true, storageUsedBytes: true },
    });

    const quota = Number(user?.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES);
    const currentUsage = Number(user?.storageUsedBytes ?? 0);

    return {
      allowed: currentUsage + additionalBytes <= quota,
      currentUsage,
      quota,
    };
  }

  /**
   * Recompute the cached storage usage from scratch via calculateStorageUsage.
   * Same slow-path warning applies — see calculateStorageUsage.
   *
   * Concurrent calls for the same user dedupe to a single in-flight scan; see
   * `inflightReconciles`. Sequential callers (e.g. the cleanup loop inside
   * `freeStorageForUpload`) still get fresh results because the lock is
   * cleared in `finally` before the awaiter resolves.
   */
  async updateStorageUsage(userId: number): Promise<void> {
    const existing = this.inflightReconciles.get(userId);
    if (existing) return existing;

    const promise = (async () => {
      try {
        const { totalBytes } = await this.calculateStorageUsage(userId);
        await prisma.user.update({
          where: { id: userId },
          data: { storageUsedBytes: BigInt(totalBytes) },
        });
      } finally {
        this.inflightReconciles.delete(userId);
      }
    })();
    this.inflightReconciles.set(userId, promise);
    return promise;
  }

  /**
   * Clear any in-flight reconcile lock for a user. Call when user data is
   * wiped (clean-slate, account deletion) so a stale rejected promise does
   * not block future reconciles.
   */
  clearForUser(userId: number): void {
    this.inflightReconciles.delete(userId);
  }

  /**
   * Get storage quota and usage for a user.
   * Used by status endpoint.
   */
  async getStorageInfo(userId: number): Promise<{
    storageUsedBytes: number;
    storageQuotaBytes: number;
  }> {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { storageQuotaBytes: true, storageUsedBytes: true },
    });

    return {
      storageUsedBytes: Number(user?.storageUsedBytes ?? 0),
      storageQuotaBytes: Number(user?.storageQuotaBytes ?? DEFAULT_STORAGE_QUOTA_BYTES),
    };
  }
}
