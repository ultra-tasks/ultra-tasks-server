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
   */
  async updateStorageUsage(userId: number): Promise<void> {
    const { totalBytes } = await this.calculateStorageUsage(userId);
    await prisma.user.update({
      where: { id: userId },
      data: { storageUsedBytes: BigInt(totalBytes) },
    });
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
