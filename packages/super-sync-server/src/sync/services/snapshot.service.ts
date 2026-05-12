/**
 * SnapshotService - Handles snapshot generation and restore points
 *
 * Extracted from SyncService for better separation of concerns.
 * This service handles snapshot caching, generation, and restore points.
 *
 * CRITICAL: FIX 1.7 - Uses in-memory locks to prevent concurrent snapshot
 * generation for the same user. This prevents duplicate expensive computation.
 */
import { Prisma } from '@prisma/client';
import { prisma, Operation as PrismaOperation } from '../../db';
import { Logger } from '../../logger';
import {
  CURRENT_SCHEMA_VERSION,
  migrateState,
  migrateOperation,
  stateNeedsMigration,
  type OperationLike,
} from '@sp/shared-schema';
import { Operation } from '../sync.types';
import { ALLOWED_ENTITY_TYPES } from './validation.service';
import { gunzipAsync, gzipAsync } from '../gzip';

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

const encryptedOpsNotSupportedMessage = (encryptedOpCount: number): string =>
  `ENCRYPTED_OPS_NOT_SUPPORTED: Cannot generate snapshot - ${encryptedOpCount} operations have encrypted payloads. ` +
  `Server-side restore is not available when E2E encryption is enabled. ` +
  `Alternative: Use the client app's "Sync Now" button which can decrypt and restore locally.`;

/**
 * Typed error thrown when snapshot generation hits encrypted ops the server
 * cannot decrypt. Route handlers should `instanceof`-check this instead of
 * substring-matching the message, and must NOT echo `message` back to the
 * client — it contains the encrypted-op count (data-volume side-channel).
 */
export class EncryptedOpsNotSupportedError extends Error {
  readonly encryptedOpCount: number;
  constructor(encryptedOpCount: number) {
    super(encryptedOpsNotSupportedMessage(encryptedOpCount));
    this.name = 'EncryptedOpsNotSupportedError';
    this.encryptedOpCount = encryptedOpCount;
  }
}

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
      // Without this clear the same error would be logged on every cache read
      // until a new snapshot is generated.
      Logger.error(
        `[user:${userId}] Failed to decompress cached snapshot, invalidating: ${(err as Error).message}`,
      );
      await this._invalidateCachedSnapshot(userId);
      return null;
    }
  }

  private async _invalidateCachedSnapshot(userId: number): Promise<void> {
    try {
      await prisma.userSyncState.update({
        where: { userId },
        data: {
          snapshotData: null,
          lastSnapshotSeq: null,
          snapshotAt: null,
          snapshotSchemaVersion: null,
        },
      });
    } catch (err) {
      // Row may have been deleted concurrently — best-effort cleanup.
      Logger.warn(
        `[user:${userId}] Failed to invalidate cached snapshot: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Cache a snapshot only when it's replayable by the server.
   * Encrypted payloads remain available as ops but cannot back snapshot
   * replay (server cannot decrypt). Owning this invariant here keeps HTTP
   * routes from having to remember the rule.
   */
  async cacheSnapshotIfReplayable(
    userId: number,
    state: unknown,
    serverSeq: number,
    isPayloadEncrypted: boolean,
  ): Promise<void> {
    if (isPayloadEncrypted) return;
    await this.cacheSnapshot(userId, state, serverSeq);
  }

  /**
   * Cache a snapshot for a user.
   *
   * Guards against stale-overwrite races between concurrent uploads: only
   * writes when no row exists yet or the cached `lastSnapshotSeq` is older
   * than `serverSeq`. The op append itself is serialized by the DB; the cache
   * write is not, so without this guard a later request finishing first could
   * be clobbered by an earlier one.
   */
  async cacheSnapshot(userId: number, state: unknown, serverSeq: number): Promise<void> {
    const now = Date.now();
    const compressed = await gzipAsync(Buffer.from(JSON.stringify(state), 'utf-8'));

    if (compressed.length > MAX_SNAPSHOT_SIZE_BYTES) {
      Logger.error(
        `[user:${userId}] Snapshot too large: ${compressed.length} bytes ` +
          `(max ${MAX_SNAPSHOT_SIZE_BYTES}). Skipping cache.`,
      );
      return;
    }

    const data = {
      snapshotData: compressed,
      lastSnapshotSeq: serverSeq,
      snapshotAt: BigInt(now),
      snapshotSchemaVersion: CURRENT_SCHEMA_VERSION,
    };

    // Conditional update — does nothing when no row exists OR when cached
    // lastSnapshotSeq is already >= serverSeq.
    const result = await prisma.userSyncState.updateMany({
      where: {
        userId,
        OR: [{ lastSnapshotSeq: null }, { lastSnapshotSeq: { lt: serverSeq } }],
      },
      data,
    });

    if (result.count === 0) {
      // Either no row exists yet (first-time-user path) or a newer snapshot
      // already won the race. Try a create — if a row was inserted between
      // the updateMany and now, the unique-userId constraint throws P2002
      // and we treat that as "newer snapshot won; nothing to do".
      try {
        await prisma.userSyncState.create({ data: { userId, ...data } });
      } catch (err) {
        if ((err as { code?: string }).code !== 'P2002') throw err;
      }
    }
  }

  /**
   * Generate a snapshot for a user at the latest sequence.
   * Uses FIX 1.7 lock to prevent concurrent generation for the same user.
   */
  async generateSnapshot(userId: number): Promise<SnapshotResult> {
    // FIX 1.7: Check if snapshot generation is already in progress for this user.
    // If so, wait for the existing generation and return its result.
    // This prevents duplicate expensive computation under concurrent requests.
    const existingPromise = this.snapshotGenerationLocks.get(userId);
    if (existingPromise) {
      Logger.info(`Waiting for existing snapshot generation for user ${userId}`);
      return existingPromise;
    }

    // Start new generation and store the promise
    const promise = this._generateSnapshotImpl(userId);
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
   */
  private async _generateSnapshotImpl(userId: number): Promise<SnapshotResult> {
    // Transaction for consistent view
    return prisma.$transaction(
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

        // Fast path: cached snapshot is already at the latest seq AND in the
        // current schema version. No replay needed → skip the encrypted-op
        // probes (they cost a findFirst + count per call).
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

        await this._assertCachedSnapshotBaseReplayable(tx, userId, startSeq);

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

        await this._assertNoEncryptedOps(tx, userId, startSeq, latestSeq);

        const BATCH_SIZE = 10000;
        let currentSeq = startSeq;
        let totalProcessed = 0;

        while (currentSeq < latestSeq) {
          const batchOps = await tx.operation.findMany({
            where: {
              userId,
              serverSeq: { gt: currentSeq, lte: latestSeq },
            },
            orderBy: { serverSeq: 'asc' },
            take: BATCH_SIZE,
          });

          const expectedFirstSeq = this._resolveExpectedFirstSeq(
            batchOps,
            currentSeq,
            startSeq,
            latestSeq,
          );
          this._assertContiguousReplayBatch(batchOps, expectedFirstSeq, latestSeq);

          // Replay ops
          state = this.replayOpsToState(batchOps, state);

          currentSeq = batchOps[batchOps.length - 1].serverSeq;
          totalProcessed += batchOps.length;

          if (totalProcessed > MAX_OPS_FOR_SNAPSHOT) {
            throw new Error(
              `Too many operations processed (${totalProcessed}). ` +
                `Max: ${MAX_OPS_FOR_SNAPSHOT}.`,
            );
          }
        }

        const generatedAt = Date.now();

        // Cache the generated snapshot inline so it matches the returned state.
        // Upsert: a user that just had a snapshot generated may still have no
        // userSyncState row (first-time path), in which case `update` throws
        // RecordNotFound.
        const compressed = await gzipAsync(Buffer.from(JSON.stringify(state), 'utf-8'));
        if (compressed.length <= MAX_SNAPSHOT_SIZE_BYTES) {
          await tx.userSyncState.upsert({
            where: { userId },
            update: {
              snapshotData: compressed,
              lastSnapshotSeq: latestSeq,
              snapshotAt: BigInt(generatedAt),
              snapshotSchemaVersion: CURRENT_SCHEMA_VERSION,
            },
            create: {
              userId,
              snapshotData: compressed,
              lastSnapshotSeq: latestSeq,
              snapshotAt: BigInt(generatedAt),
              snapshotSchemaVersion: CURRENT_SCHEMA_VERSION,
            },
          });
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
        // Prevent races between `_assertNoEncryptedOps` / `_assertCachedSnapshotBaseReplayable`
        // and the subsequent `findMany` batches: a concurrent writer must not be able to
        // slip an encrypted op into the snapshot window after the guards have passed.
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
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

        await this._assertCachedSnapshotBaseReplayable(tx, userId, startSeq);

        const totalOpsToProcess = targetSeq - startSeq;
        if (totalOpsToProcess > MAX_OPS_FOR_SNAPSHOT) {
          throw new Error(
            `Too many operations to process (${totalOpsToProcess}). ` +
              `Max: ${MAX_OPS_FOR_SNAPSHOT}.`,
          );
        }

        await this._assertNoEncryptedOps(tx, userId, startSeq, targetSeq);

        // Replay ops from startSeq to targetSeq
        const BATCH_SIZE = 10000;
        let currentSeq = startSeq;

        while (currentSeq < targetSeq) {
          const batchOps = await tx.operation.findMany({
            where: {
              userId,
              serverSeq: { gt: currentSeq, lte: targetSeq },
            },
            orderBy: { serverSeq: 'asc' },
            take: BATCH_SIZE,
          });

          const expectedFirstSeq = this._resolveExpectedFirstSeq(
            batchOps,
            currentSeq,
            startSeq,
            targetSeq,
          );
          this._assertContiguousReplayBatch(batchOps, expectedFirstSeq, targetSeq);

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
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      },
    );
  }

  /**
   * Replay operations to build state.
   * Used internally by snapshot generation methods.
   */
  replayOpsToState(
    ops: PrismaOperation[],
    initialState: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const state = { ...(initialState as Record<string, Record<string, unknown>>) };

    for (let i = 0; i < ops.length; i++) {
      const row = ops[i];

      // Server cannot decrypt E2E payloads. Snapshot callers reject encrypted
      // ranges upfront; this guard prevents accidental partial replays.
      if (row.isPayloadEncrypted) {
        throw new EncryptedOpsNotSupportedError(1);
      }

      // Periodically check state size to prevent memory exhaustion.
      // Measure in UTF-8 bytes (Buffer.byteLength) so the limit matches the
      // constant's documented unit — JSON.stringify(state).length counts
      // UTF-16 code units, which under-counts up to 4x for non-ASCII content.
      if (i > 0 && i % REPLAY_SIZE_CHECK_INTERVAL === 0) {
        const estimatedSize = Buffer.byteLength(JSON.stringify(state), 'utf8');
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

        // Handle full-state operations BEFORE entity type check.
        // These operations REPLACE the entire state (they represent a complete
        // snapshot of the app), so we must clear existing keys first —
        // otherwise stale entity types from a prior state survive a "reset"
        // and `_resolveExpectedFirstSeq`'s leading-gap acceptance becomes
        // incorrect (the gap is only safe if the full-state op truly resets).
        if (
          processOpType === 'SYNC_IMPORT' ||
          processOpType === 'BACKUP_IMPORT' ||
          processOpType === 'REPAIR'
        ) {
          const fullState =
            processPayload &&
            typeof processPayload === 'object' &&
            'appDataComplete' in processPayload
              ? (processPayload as { appDataComplete: unknown }).appDataComplete
              : processPayload;
          // A malformed full-state op (null/primitive payload) would silently
          // wipe state if we cleared first. Refuse to replay it — a corrupt
          // SYNC_IMPORT is invariant-breaking, not a no-op.
          if (!fullState || typeof fullState !== 'object') {
            throw new Error(
              `SNAPSHOT_REPLAY_INCOMPLETE: ${processOpType} op ${row.id} has non-object payload`,
            );
          }
          for (const key of Object.keys(state)) {
            delete state[key];
          }
          Object.assign(state, fullState);
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

  private async _assertNoEncryptedOps(
    tx: Prisma.TransactionClient,
    userId: number,
    startSeq: number,
    targetSeq: number,
  ): Promise<void> {
    if (startSeq >= targetSeq) return;

    const encryptedOpCount = await tx.operation.count({
      where: {
        userId,
        serverSeq: { gt: startSeq, lte: targetSeq },
        isPayloadEncrypted: true,
      },
    });

    if (encryptedOpCount > 0) {
      throw new EncryptedOpsNotSupportedError(encryptedOpCount);
    }
  }

  private async _assertCachedSnapshotBaseReplayable(
    tx: Prisma.TransactionClient,
    userId: number,
    startSeq: number,
  ): Promise<void> {
    if (startSeq <= 0) return;

    const latestUnencryptedFullStateOp = await tx.operation.findFirst({
      where: {
        userId,
        serverSeq: { lte: startSeq },
        opType: { in: ['SYNC_IMPORT', 'BACKUP_IMPORT', 'REPAIR'] },
        isPayloadEncrypted: false,
      },
      orderBy: { serverSeq: 'desc' },
      select: { serverSeq: true },
    });

    const encryptedOpCount = await tx.operation.count({
      where: {
        userId,
        serverSeq: {
          gt: latestUnencryptedFullStateOp?.serverSeq ?? 0,
          lte: startSeq,
        },
        isPayloadEncrypted: true,
      },
    });

    if (encryptedOpCount > 0) {
      throw new EncryptedOpsNotSupportedError(encryptedOpCount);
    }
  }

  /**
   * Decide where contiguity checking should start for the current batch.
   *
   * The replay base may sit below the lowest op that physically exists, e.g.:
   *   - After a clean-slate upload (`sync.service.ts` preserves `lastSeq` but deletes ops).
   *   - After retention pruning (`deleteOldestRestorePointAndOps`) trimmed older ops.
   * In both cases the surviving lowest-seq op is guaranteed to be a full-state op
   * (SYNC_IMPORT / BACKUP_IMPORT / REPAIR) that resets state during replay. Accept
   * this leading gap only on the first batch and only when that invariant holds;
   * mid-stream gaps still indicate corruption and must throw.
   */
  private _resolveExpectedFirstSeq(
    batchOps: PrismaOperation[],
    currentSeq: number,
    startSeq: number,
    targetSeq: number,
  ): number {
    if (currentSeq !== startSeq || batchOps.length === 0) {
      return currentSeq + 1;
    }
    const firstOp = batchOps[0];
    if (firstOp.serverSeq <= currentSeq + 1) {
      return currentSeq + 1;
    }
    const isFullStateOp =
      firstOp.opType === 'SYNC_IMPORT' ||
      firstOp.opType === 'BACKUP_IMPORT' ||
      firstOp.opType === 'REPAIR';
    if (!isFullStateOp) {
      throw new Error(
        `SNAPSHOT_REPLAY_INCOMPLETE: Expected operation serverSeq ${currentSeq + 1} but got ${firstOp.serverSeq} while replaying to ${targetSeq}`,
      );
    }
    return firstOp.serverSeq;
  }

  private _assertContiguousReplayBatch(
    batchOps: PrismaOperation[],
    expectedFirstSeq: number,
    targetSeq: number,
  ): void {
    if (batchOps.length === 0) {
      throw new Error(
        `SNAPSHOT_REPLAY_INCOMPLETE: Missing operation at serverSeq ${expectedFirstSeq} while replaying to ${targetSeq}`,
      );
    }

    for (let i = 0; i < batchOps.length; i++) {
      const expectedSeq = expectedFirstSeq + i;
      const actualSeq = batchOps[i].serverSeq;
      if (actualSeq !== expectedSeq) {
        throw new Error(
          `SNAPSHOT_REPLAY_INCOMPLETE: Expected operation serverSeq ${expectedSeq} but got ${actualSeq} while replaying to ${targetSeq}`,
        );
      }
    }
  }
}
