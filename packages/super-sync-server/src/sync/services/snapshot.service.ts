/**
 * SnapshotService - Handles snapshot generation and restore points
 *
 * Extracted from SyncService for better separation of concerns.
 * This service handles snapshot caching, generation, and restore points.
 *
 * CRITICAL: FIX 1.7 - Uses in-memory locks to prevent concurrent snapshot
 * generation for the same user. This prevents duplicate expensive computation.
 */
import * as zlib from 'zlib';
import { promisify } from 'util';
import { prisma } from '../../db';
import { Logger } from '../../logger';

const gzipAsync = promisify(zlib.gzip) as (buf: zlib.InputType) => Promise<Buffer>;
const gunzipAsync = promisify(zlib.gunzip) as (
  buf: zlib.InputType,
  opts?: zlib.ZlibOptions,
) => Promise<Buffer>;
import {
  CURRENT_SCHEMA_VERSION,
  migrateState,
  migrateOperation,
  stateNeedsMigration,
  type OperationLike,
} from '@sp/shared-schema';
import { Operation } from '../sync.types';
import { ALLOWED_ENTITY_TYPES } from './validation.service';

/**
 * Maximum operations to process during snapshot generation.
 * Prevents memory exhaustion for users with excessive operation history.
 */
const MAX_OPS_FOR_SNAPSHOT = 100000;

/**
 * Maximum compressed snapshot size in bytes (50MB).
 * Prevents storage exhaustion from excessively large snapshots.
 */
const MAX_SNAPSHOT_SIZE_BYTES = 50 * 1024 * 1024;

/**
 * Maximum decompressed snapshot size in bytes (100MB).
 * Prevents zip bombs from exhausting memory when reading cached snapshots.
 */
const MAX_SNAPSHOT_DECOMPRESSED_BYTES = 100 * 1024 * 1024;

/**
 * Maximum state size during replay (100MB).
 * Prevents memory exhaustion from malicious or corrupted data.
 */
const MAX_REPLAY_STATE_SIZE_BYTES = 100 * 1024 * 1024;

/**
 * How often to check state size during replay (every N operations).
 */
const REPLAY_SIZE_CHECK_INTERVAL = 1000;

const REPLAY_OPERATION_SELECT = {
  id: true,
  serverSeq: true,
  opType: true,
  entityType: true,
  entityId: true,
  payload: true,
  schemaVersion: true,
  isPayloadEncrypted: true,
} as const;

type ReplayOperationRow = {
  id: string;
  serverSeq: number;
  opType: string;
  entityType: string;
  entityId: string | null;
  payload: unknown;
  schemaVersion: number;
  isPayloadEncrypted: boolean;
};

const assertContiguousReplayBatch = (
  ops: ReplayOperationRow[],
  expectedFirstSeq: number,
  targetSeq: number,
): void => {
  if (ops.length === 0) {
    throw new Error(
      `SNAPSHOT_REPLAY_INCOMPLETE: Missing operations from seq ${expectedFirstSeq} to ${targetSeq}.`,
    );
  }

  let expectedSeq = expectedFirstSeq;
  for (const op of ops) {
    if (op.serverSeq !== expectedSeq) {
      throw new Error(
        `SNAPSHOT_REPLAY_INCOMPLETE: Expected seq ${expectedSeq} but got ${op.serverSeq} while replaying to seq ${targetSeq}.`,
      );
    }
    expectedSeq++;
  }
};

export interface SnapshotResult {
  state: unknown;
  serverSeq: number;
  generatedAt: number;
  schemaVersion: number;
}

export interface RestorePoint {
  serverSeq: number;
  timestamp: number;
  type: 'SYNC_IMPORT' | 'BACKUP_IMPORT' | 'REPAIR';
  clientId: string;
  description?: string;
}

export interface PreparedSnapshotCache {
  data: Buffer;
  bytes: number;
  stateBytes: number;
  cacheable: boolean;
}

export interface CacheSnapshotResult {
  cached: boolean;
  bytesWritten: number;
  previousBytes: number;
  deltaBytes: number;
}

export class SnapshotService {
  /**
   * FIX 1.7: In-memory lock to prevent concurrent snapshot generation for the same user.
   * Maps userId to a Promise that resolves when generation completes.
   * Concurrent requests wait for the existing generation and reuse its result.
   */
  private snapshotGenerationLocks: Map<number, Promise<SnapshotResult>> = new Map();

  /**
   * Clear any cached state for a user (e.g., when user data is deleted).
   */
  clearForUser(userId: number): void {
    this.snapshotGenerationLocks.delete(userId);
  }

  /**
   * Get cached snapshot for a user.
   */
  async getCachedSnapshot(userId: number): Promise<SnapshotResult | null> {
    const row = await prisma.userSyncState.findUnique({
      where: { userId },
      select: {
        snapshotData: true,
        lastSnapshotSeq: true,
        snapshotAt: true,
        snapshotSchemaVersion: true,
      },
    });

    if (!row?.snapshotData) return null;

    try {
      // Decompress snapshot off the synchronous fast path so a large snapshot
      // does not stall the event loop for all other tenants.
      const decompressed = (
        await gunzipAsync(row.snapshotData, {
          maxOutputLength: MAX_SNAPSHOT_DECOMPRESSED_BYTES,
        })
      ).toString('utf-8');
      return {
        state: JSON.parse(decompressed),
        serverSeq: row.lastSnapshotSeq ?? 0,
        generatedAt: Number(row.snapshotAt) ?? 0,
        schemaVersion: row.snapshotSchemaVersion ?? 1,
      };
    } catch (err) {
      Logger.error(
        `[user:${userId}] Failed to decompress cached snapshot: ${(err as Error).message}`,
      );
      return null;
    }
  }

  /**
   * Serialize + gzip a snapshot off the event loop. Returns the prepared blob
   * plus byte accounting needed by quota tracking.
   */
  async prepareSnapshotCache(state: unknown): Promise<PreparedSnapshotCache> {
    const serialized = JSON.stringify(state);
    const data = await gzipAsync(serialized);
    return {
      data,
      bytes: data.length,
      stateBytes: Buffer.byteLength(serialized, 'utf8'),
      cacheable: data.length <= MAX_SNAPSHOT_SIZE_BYTES,
    };
  }

  async getCachedSnapshotBytes(userId: number): Promise<number> {
    const result = await prisma.$queryRaw<[{ bytes: number | bigint | null }]>`
      SELECT COALESCE(octet_length(snapshot_data), 0) as bytes
      FROM user_sync_state WHERE user_id = ${userId}
    `;
    return Number(result[0]?.bytes ?? 0);
  }

  async cacheSnapshot(
    userId: number,
    state: unknown,
    serverSeq: number,
    preparedSnapshot?: PreparedSnapshotCache,
  ): Promise<CacheSnapshotResult> {
    const now = Date.now();
    const prepared = preparedSnapshot ?? (await this.prepareSnapshotCache(state));
    const previousBytes = await this.getCachedSnapshotBytes(userId);

    if (!prepared.cacheable) {
      Logger.error(
        `[user:${userId}] Snapshot too large: ${prepared.bytes} bytes ` +
          `(max ${MAX_SNAPSHOT_SIZE_BYTES}). Clearing stale cache.`,
      );
      // Drop any previously-cached snapshot so callers don't see an outdated
      // blob alongside ops the new (rejected) snapshot was supposed to cover.
      // Returns the negative delta so storage accounting credits the freed
      // space.
      if (previousBytes > 0) {
        await prisma.userSyncState.update({
          where: { userId },
          data: {
            snapshotData: null,
            lastSnapshotSeq: null,
            snapshotAt: null,
            snapshotSchemaVersion: null,
          },
        });
      }
      return {
        cached: false,
        bytesWritten: 0,
        previousBytes,
        // Avoid producing -0 when there was no previous snapshot.
        deltaBytes: previousBytes > 0 ? -previousBytes : 0,
      };
    }

    await prisma.userSyncState.update({
      where: { userId },
      data: {
        snapshotData: prepared.data,
        lastSnapshotSeq: serverSeq,
        snapshotAt: BigInt(now),
        snapshotSchemaVersion: CURRENT_SCHEMA_VERSION,
      },
    });

    return {
      cached: true,
      bytesWritten: prepared.bytes,
      previousBytes,
      deltaBytes: prepared.bytes - previousBytes,
    };
  }

  /**
   * Generate a snapshot for a user at the latest sequence.
   * Uses FIX 1.7 lock to prevent concurrent generation for the same user.
   *
   * `onCacheDelta` (optional) is invoked with the byte change applied to the
   * `snapshotData` column when the cache is rewritten. Callers should use this
   * to keep the storage usage counter in sync with on-disk reality — otherwise
   * `GET /snapshot` can grow `snapshotData` by up to ~MAX_SNAPSHOT_SIZE_BYTES
   * without the counter noticing.
   */
  async generateSnapshot(
    userId: number,
    onCacheDelta?: (deltaBytes: number) => Promise<void>,
  ): Promise<SnapshotResult> {
    // FIX 1.7: Check if snapshot generation is already in progress for this user.
    // If so, wait for the existing generation and return its result.
    // This prevents duplicate expensive computation under concurrent requests.
    const existingPromise = this.snapshotGenerationLocks.get(userId);
    if (existingPromise) {
      Logger.info(`Waiting for existing snapshot generation for user ${userId}`);
      return existingPromise;
    }

    // Start new generation and store the promise
    const promise = this._generateSnapshotImpl(userId, onCacheDelta);
    this.snapshotGenerationLocks.set(userId, promise);

    try {
      return await promise;
    } finally {
      // Clean up lock when done (whether success or failure)
      this.snapshotGenerationLocks.delete(userId);
    }
  }

  /**
   * Internal implementation of snapshot generation.
   * Called only when no concurrent generation is in progress.
   *
   * If a counter delta needs applying (cache was rewritten), the delta is
   * captured by the closure into `cacheDelta` and applied AFTER the
   * transaction commits via the optional `onCacheDelta` callback. This keeps
   * the slow counter update out of the snapshot transaction window while
   * still letting storage accounting self-heal.
   */
  private async _generateSnapshotImpl(
    userId: number,
    onCacheDelta?: (deltaBytes: number) => Promise<void>,
  ): Promise<SnapshotResult> {
    let cacheDelta = 0;
    const result = await prisma.$transaction(
      async (tx) => {
        // Get latest seq in this transaction
        const seqRow = await tx.userSyncState.findUnique({
          where: { userId },
          select: { lastSeq: true },
        });
        const latestSeq = seqRow?.lastSeq ?? 0;

        let state: Record<string, unknown> = {};
        let startSeq = 0;
        let snapshotSchemaVersion = CURRENT_SCHEMA_VERSION;

        // Try to get cached snapshot (need to fetch it inside tx for consistency?
        // Actually, we can fetch it. If it's old, we just replay more ops.)
        // Re-implementing getCachedSnapshot logic inside tx
        const cachedRow = await tx.userSyncState.findUnique({
          where: { userId },
          select: {
            snapshotData: true,
            lastSnapshotSeq: true,
            snapshotAt: true,
            snapshotSchemaVersion: true,
          },
        });

        if (cachedRow?.snapshotData) {
          try {
            const decompressed = (
              await gunzipAsync(cachedRow.snapshotData, {
                maxOutputLength: MAX_SNAPSHOT_DECOMPRESSED_BYTES,
              })
            ).toString('utf-8');
            state = JSON.parse(decompressed) as Record<string, unknown>;
            startSeq = cachedRow.lastSnapshotSeq ?? 0;
            snapshotSchemaVersion = cachedRow.snapshotSchemaVersion ?? 1;
          } catch (err) {
            // Ignore corrupted cache
          }
        }

        if (
          startSeq >= latestSeq &&
          cachedRow?.snapshotData &&
          snapshotSchemaVersion === CURRENT_SCHEMA_VERSION
        ) {
          return {
            state,
            serverSeq: startSeq,
            generatedAt: Date.now(),
            schemaVersion: CURRENT_SCHEMA_VERSION,
          };
        }

        const previousCachedBytes = cachedRow?.snapshotData?.length ?? 0;

        // Migrate snapshot if needed
        if (stateNeedsMigration(snapshotSchemaVersion, CURRENT_SCHEMA_VERSION)) {
          Logger.info(
            `[user:${userId}] Migrating snapshot from v${snapshotSchemaVersion} to v${CURRENT_SCHEMA_VERSION}`,
          );
          const migrationResult = migrateState(
            state,
            snapshotSchemaVersion,
            CURRENT_SCHEMA_VERSION,
          );
          if (!migrationResult.success) {
            throw new Error(`Snapshot migration failed: ${migrationResult.error}`);
          }
          state = migrationResult.data as Record<string, unknown>;
          snapshotSchemaVersion = CURRENT_SCHEMA_VERSION;
        }

        const totalOpsToProcess = latestSeq - startSeq;
        if (totalOpsToProcess > MAX_OPS_FOR_SNAPSHOT) {
          throw new Error(
            `Too many operations to process (${totalOpsToProcess}). ` +
              `Max: ${MAX_OPS_FOR_SNAPSHOT}.`,
          );
        }

        if (totalOpsToProcess > 0) {
          // Server-side snapshots cannot safely replay encrypted payloads.
          const encryptedOpCount = await tx.operation.count({
            where: {
              userId,
              serverSeq: { gt: startSeq, lte: latestSeq },
              isPayloadEncrypted: true,
            },
          });

          if (encryptedOpCount > 0) {
            throw new Error(
              `ENCRYPTED_OPS_NOT_SUPPORTED: Cannot generate snapshot - ${encryptedOpCount} operations have encrypted payloads. ` +
                `Server-side snapshots are not available when E2E encryption is enabled.`,
            );
          }
        }

        const BATCH_SIZE = 10000;
        let currentSeq = startSeq;
        let totalProcessed = 0;

        while (currentSeq < latestSeq) {
          const batchOps = await tx.operation.findMany({
            where: {
              userId,
              // Keep the replay aligned with the advertised snapshot sequence.
              serverSeq: { gt: currentSeq, lte: latestSeq },
            },
            orderBy: { serverSeq: 'asc' },
            take: BATCH_SIZE,
            select: REPLAY_OPERATION_SELECT,
          });

          assertContiguousReplayBatch(batchOps, currentSeq + 1, latestSeq);

          // Replay ops
          state = this.replayOpsToState(batchOps, state);

          currentSeq = batchOps[batchOps.length - 1].serverSeq;
          totalProcessed += batchOps.length;

          if (totalProcessed > MAX_OPS_FOR_SNAPSHOT) break;
        }

        const generatedAt = Date.now();

        // Update cache inside the transaction so the cached snapshot matches
        // the returned state. Gzip is async so the event loop stays
        // responsive for other tenants; the txn timeout (60s) is generous
        // enough to cover it. Capture the byte delta so the storage counter
        // can be updated AFTER the txn commits (see `cacheDelta`).
        const compressed = await gzipAsync(JSON.stringify(state));
        if (compressed.length <= MAX_SNAPSHOT_SIZE_BYTES) {
          await tx.userSyncState.update({
            where: { userId },
            data: {
              snapshotData: compressed,
              lastSnapshotSeq: latestSeq,
              snapshotAt: BigInt(generatedAt),
              snapshotSchemaVersion: CURRENT_SCHEMA_VERSION,
            },
          });
          cacheDelta = compressed.length - previousCachedBytes;
        }

        return {
          state,
          serverSeq: latestSeq,
          generatedAt,
          schemaVersion: CURRENT_SCHEMA_VERSION,
        };
      },
      {
        timeout: 60000, // Snapshots can take time
      },
    );

    if (onCacheDelta && cacheDelta !== 0) {
      try {
        await onCacheDelta(cacheDelta);
      } catch (err) {
        Logger.warn(
          `[user:${userId}] generateSnapshot cache-delta hook failed: ${
            (err as Error).message
          }`,
        );
      }
    }

    return result;
  }

  /**
   * Get available restore points for a user.
   * Returns significant state-change operations (SYNC_IMPORT, BACKUP_IMPORT, REPAIR)
   * which represent complete snapshots of the application state.
   */
  async getRestorePoints(userId: number, limit: number = 30): Promise<RestorePoint[]> {
    // Query for full-state operations only
    const ops = await prisma.operation.findMany({
      where: {
        userId,
        opType: {
          in: ['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR'],
        },
      },
      orderBy: {
        serverSeq: 'desc',
      },
      take: limit,
      select: {
        serverSeq: true,
        clientId: true,
        opType: true,
        clientTimestamp: true,
      },
    });

    return ops.map((op) => ({
      serverSeq: op.serverSeq,
      timestamp: Number(op.clientTimestamp),
      type: op.opType as 'SYNC_IMPORT' | 'BACKUP_IMPORT' | 'REPAIR',
      clientId: op.clientId,
      description: this._getRestorePointDescription(
        op.opType as 'SYNC_IMPORT' | 'BACKUP_IMPORT' | 'REPAIR',
      ),
    }));
  }

  private _getRestorePointDescription(
    opType: 'SYNC_IMPORT' | 'BACKUP_IMPORT' | 'REPAIR',
  ): string {
    switch (opType) {
      case 'SYNC_IMPORT':
        return 'Full sync import';
      case 'BACKUP_IMPORT':
        return 'Backup restore';
      case 'REPAIR':
        return 'Auto-repair';
      default:
        return 'State snapshot';
    }
  }

  /**
   * Generate a snapshot at a specific serverSeq.
   * Replays operations from the beginning (or cached snapshot) up to targetSeq.
   */
  async generateSnapshotAtSeq(
    userId: number,
    targetSeq: number,
  ): Promise<{
    state: unknown;
    serverSeq: number;
    generatedAt: number;
  }> {
    return prisma.$transaction(
      async (tx) => {
        // Verify targetSeq is valid
        const maxSeqRow = await tx.userSyncState.findUnique({
          where: { userId },
          select: { lastSeq: true },
        });
        const maxSeq = maxSeqRow?.lastSeq ?? 0;

        if (targetSeq > maxSeq) {
          throw new Error(
            `Target sequence ${targetSeq} exceeds latest sequence ${maxSeq}`,
          );
        }

        if (targetSeq < 1) {
          throw new Error('Target sequence must be at least 1');
        }

        let state: Record<string, unknown> = {};
        let startSeq = 0;

        // Try to use cached snapshot as base if it's before targetSeq
        const cachedRow = await tx.userSyncState.findUnique({
          where: { userId },
          select: {
            snapshotData: true,
            lastSnapshotSeq: true,
            snapshotSchemaVersion: true,
          },
        });

        if (
          cachedRow?.snapshotData &&
          cachedRow.lastSnapshotSeq &&
          cachedRow.lastSnapshotSeq <= targetSeq
        ) {
          try {
            const decompressed = (
              await gunzipAsync(cachedRow.snapshotData, {
                maxOutputLength: MAX_SNAPSHOT_DECOMPRESSED_BYTES,
              })
            ).toString('utf-8');
            state = JSON.parse(decompressed) as Record<string, unknown>;
            startSeq = cachedRow.lastSnapshotSeq;

            // Migrate if needed
            const snapshotSchemaVersion = cachedRow.snapshotSchemaVersion ?? 1;
            if (stateNeedsMigration(snapshotSchemaVersion, CURRENT_SCHEMA_VERSION)) {
              const migrationResult = migrateState(
                state,
                snapshotSchemaVersion,
                CURRENT_SCHEMA_VERSION,
              );
              if (migrationResult.success) {
                state = migrationResult.data as Record<string, unknown>;
              }
            }
          } catch (err) {
            // Ignore corrupted cache, start from scratch
            Logger.warn(
              `[user:${userId}] Failed to use cached snapshot: ${(err as Error).message}`,
            );
          }
        }

        const totalOpsToProcess = targetSeq - startSeq;
        if (totalOpsToProcess > MAX_OPS_FOR_SNAPSHOT) {
          throw new Error(
            `Too many operations to process (${totalOpsToProcess}). ` +
              `Max: ${MAX_OPS_FOR_SNAPSHOT}.`,
          );
        }

        // Check for encrypted ops in the range - server cannot replay encrypted payloads
        const encryptedOpCount = await tx.operation.count({
          where: {
            userId,
            serverSeq: { gt: startSeq, lte: targetSeq },
            isPayloadEncrypted: true,
          },
        });

        if (encryptedOpCount > 0) {
          throw new Error(
            `ENCRYPTED_OPS_NOT_SUPPORTED: Cannot generate snapshot - ${encryptedOpCount} operations have encrypted payloads. ` +
              `Server-side restore is not available when E2E encryption is enabled. ` +
              `Alternative: Use the client app's "Sync Now" button which can decrypt and restore locally.`,
          );
        }

        // Replay ops from startSeq to targetSeq
        const BATCH_SIZE = 10000;
        let currentSeq = startSeq;

        while (currentSeq < targetSeq) {
          const batchOps = await tx.operation.findMany({
            where: {
              userId,
              // Historical restore points replay only up to the requested sequence.
              serverSeq: { gt: currentSeq, lte: targetSeq },
            },
            orderBy: { serverSeq: 'asc' },
            take: BATCH_SIZE,
            select: REPLAY_OPERATION_SELECT,
          });

          assertContiguousReplayBatch(batchOps, currentSeq + 1, targetSeq);

          state = this.replayOpsToState(batchOps, state);
          currentSeq = batchOps[batchOps.length - 1].serverSeq;
        }

        return {
          state,
          serverSeq: targetSeq,
          generatedAt: Date.now(),
        };
      },
      {
        timeout: 60000, // Snapshot generation can take time
      },
    );
  }

  /**
   * Replay operations to build state.
   * Used internally by snapshot generation methods.
   */
  replayOpsToState(
    ops: ReplayOperationRow[],
    initialState: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const state = { ...(initialState as Record<string, Record<string, unknown>>) };

    for (let i = 0; i < ops.length; i++) {
      const row = ops[i];

      // Skip encrypted operations - server cannot decrypt E2E encrypted payloads
      // This is a defensive check; generateSnapshotAtSeq should reject encrypted ops upfront
      if (row.isPayloadEncrypted) {
        Logger.warn(
          `[replayOpsToState] Skipping encrypted op ${row.id} (seq=${row.serverSeq})`,
        );
        continue;
      }

      // Periodically check state size to prevent memory exhaustion
      if (i > 0 && i % REPLAY_SIZE_CHECK_INTERVAL === 0) {
        const estimatedSize = JSON.stringify(state).length;
        if (estimatedSize > MAX_REPLAY_STATE_SIZE_BYTES) {
          throw new Error(
            `State too large during replay: ${Math.round(estimatedSize / 1024 / 1024)}MB ` +
              `(max: ${Math.round(MAX_REPLAY_STATE_SIZE_BYTES / 1024 / 1024)}MB)`,
          );
        }
      }

      let opType = row.opType as Operation['opType'];
      let entityType = row.entityType;
      let entityId = row.entityId;
      let payload = row.payload;

      const opSchemaVersion = row.schemaVersion ?? 1;

      // Prepare list of operations to process (may be expanded by migration)
      let opsToProcess: Array<{
        opType: string;
        entityType: string;
        entityId: string | null;
        payload: unknown;
      }> = [{ opType, entityType, entityId, payload }];

      if (opSchemaVersion < CURRENT_SCHEMA_VERSION) {
        const opLike: OperationLike = {
          id: row.id,
          opType,
          entityType,
          entityId: entityId ?? undefined,
          payload,
          schemaVersion: opSchemaVersion,
        };

        const migrationResult = migrateOperation(opLike, CURRENT_SCHEMA_VERSION);
        if (!migrationResult.success) {
          continue;
        }
        const migratedOp = migrationResult.data;
        if (!migratedOp) continue;

        // Handle array result (operation was split into multiple)
        if (Array.isArray(migratedOp)) {
          opsToProcess = migratedOp.map((op) => ({
            opType: op.opType,
            entityType: op.entityType,
            entityId: op.entityId ?? null,
            payload: op.payload,
          }));
        } else {
          opsToProcess = [
            {
              opType: migratedOp.opType,
              entityType: migratedOp.entityType,
              entityId: migratedOp.entityId ?? null,
              payload: migratedOp.payload,
            },
          ];
        }
      }

      // Process all operations (original or migrated)
      for (const opToProcess of opsToProcess) {
        const {
          opType: processOpType,
          entityType: processEntityType,
          entityId: processEntityId,
          payload: processPayload,
        } = opToProcess;

        // Handle full-state operations BEFORE entity type check
        // These operations replace the entire state and don't use a specific entity type
        if (
          processOpType === 'SYNC_IMPORT' ||
          processOpType === 'BACKUP_IMPORT' ||
          processOpType === 'REPAIR'
        ) {
          if (
            processPayload &&
            typeof processPayload === 'object' &&
            'appDataComplete' in processPayload
          ) {
            Object.assign(
              state,
              (processPayload as { appDataComplete: unknown }).appDataComplete,
            );
          } else {
            Object.assign(state, processPayload);
          }
          continue;
        }

        if (!ALLOWED_ENTITY_TYPES.has(processEntityType)) continue;

        if (!state[processEntityType]) {
          state[processEntityType] = {};
        }

        switch (processOpType) {
          case 'CRT':
          case 'UPD':
            if (processEntityId) {
              state[processEntityType][processEntityId] = {
                ...(state[processEntityType][processEntityId] as Record<string, unknown>),
                ...(processPayload as Record<string, unknown>),
              };
            }
            break;
          case 'DEL':
            if (processEntityId) {
              delete state[processEntityType][processEntityId];
            }
            break;
          case 'MOV':
            if (processEntityId && processPayload) {
              state[processEntityType][processEntityId] = {
                ...(state[processEntityType][processEntityId] as Record<string, unknown>),
                ...(processPayload as Record<string, unknown>),
              };
            }
            break;
          case 'BATCH':
            if (processPayload && typeof processPayload === 'object') {
              const batchPayload = processPayload as Record<string, unknown>;
              if (batchPayload.entities && typeof batchPayload.entities === 'object') {
                const entities = batchPayload.entities as Record<string, unknown>;
                for (const [id, entity] of Object.entries(entities)) {
                  state[processEntityType][id] = {
                    ...(state[processEntityType][id] as Record<string, unknown>),
                    ...(entity as Record<string, unknown>),
                  };
                }
              } else if (processEntityId) {
                state[processEntityType][processEntityId] = {
                  ...(state[processEntityType][processEntityId] as Record<
                    string,
                    unknown
                  >),
                  ...batchPayload,
                };
              }
            }
            break;
        }
      }
    }
    return state;
  }
}
