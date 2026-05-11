import type { ApplyOperationsOptions, ApplyOperationsResult } from './apply.types';
import type { Operation, OperationLogEntry } from './operation.types';

/**
 * Minimal action shape used at sync-core boundaries.
 *
 * Hosts keep their framework-specific action types app-side. The core only
 * requires an opaque action type string and preserves any host metadata.
 */
export interface SyncActionLike {
  type: string;
  meta?: unknown;
}

/**
 * Port for applying operation batches to host state.
 */
export interface OperationApplyPort<TOperation extends Operation<string> = Operation> {
  applyOperations(
    ops: TOperation[],
    options?: ApplyOperationsOptions,
  ): Promise<ApplyOperationsResult<TOperation>>;
}

/**
 * Port for dispatching host actions.
 *
 * Implementations must preserve action objects, especially host `meta`, exactly.
 */
export interface ActionDispatchPort<TAction extends SyncActionLike = SyncActionLike> {
  dispatch(action: TAction): void;
}

/**
 * Port for suppressing local side effects while remote operations replay.
 */
export interface RemoteApplyWindowPort {
  startApplyingRemoteOps(): void;
  endApplyingRemoteOps(): void;
  startPostSyncCooldown(durationMs?: number): void;
  isApplyingRemoteOps?(): boolean;
}

/**
 * Port for flushing local user actions that were deferred during remote replay.
 */
export interface DeferredLocalActionsPort {
  processDeferredActions(): Promise<void> | void;
}

/**
 * Port for host-owned side effects that must run after remote action replay.
 */
export interface ArchiveSideEffectPort<TAction extends SyncActionLike = SyncActionLike> {
  handleOperation(action: TAction): Promise<void> | void;
}

/**
 * Port for operation-log persistence.
 *
 * This is intentionally small until orchestration code is moved. Add methods as
 * specific core coordinators need them rather than mirroring an app database
 * service wholesale.
 */
export interface OperationStorePort<
  TOperation extends Operation<string> = Operation,
  TEntry extends OperationLogEntry<TOperation> = OperationLogEntry<TOperation>,
> {
  getUnsynced(): Promise<TEntry[]>;
  markSynced(seqs: number[]): Promise<void>;
  markRejected(opIds: string[]): Promise<void>;
}
