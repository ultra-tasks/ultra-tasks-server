// Operation log primitives — the generic, app-agnostic core of the sync engine.
export {
  OpType,
  FULL_STATE_OP_TYPES,
  isFullStateOpType,
  isMultiEntityPayload,
  extractActionPayload,
} from './operation.types';
export type {
  VectorClock,
  Operation,
  OperationLogEntry,
  EntityConflict,
  ConflictResult,
  EntityChange,
  MultiEntityPayload,
} from './operation.types';

// Vector-clock algorithms — single source of truth for client/server parity.
export {
  compareVectorClocks,
  mergeVectorClocks,
  limitVectorClockSize,
  MAX_VECTOR_CLOCK_SIZE,
} from './vector-clock';
export type { VectorClockComparison } from './vector-clock';

// Full-state import clean-slate vector-clock decisions.
export { classifyOpAgainstSyncImport } from './sync-import-filter';
export type {
  SyncImportFilterClockSource,
  SyncImportFilterDecision,
  SyncImportFilterDecisionReason,
  SyncImportFilterInvalidateReason,
  SyncImportFilterKeepReason,
} from './sync-import-filter';

// LWW (Last-Writer-Wins) update action-type helpers — factory parameterized by
// the host application's entity-type list, so the lib stays domain-agnostic.
export { createLwwUpdateActionTypeHelpers } from './lww-update-action-types';
export type { LwwUpdateActionTypeHelpers } from './lww-update-action-types';

// Apply-operation result and option types.
export type { ApplyOperationsResult, ApplyOperationsOptions } from './apply.types';

// Conflict-resolution helpers.
export {
  adjustForClockCorruption,
  buildEntityFrontier,
  convertLocalDeleteRemoteUpdatesToLww,
  deepEqual,
  extractEntityFromPayload,
  extractUpdateChanges,
  isIdenticalConflict,
  partitionLwwResolutions,
  planLwwConflictResolutions,
  suggestConflictResolution,
} from './conflict-resolution';
export type {
  ClockCorruptionAdjustmentOptions,
  ConflictResolutionSuggestion,
  DeepEqualOptions,
  EntityConflictLike,
  EntityFrontierContext,
  LocalDeleteRemoteUpdateConversionOptions,
  LwwConflictResolutionPlan,
  LwwConflictResolutionPlanningOptions,
  LwwConflictResolutionReason,
  LwwConflictResolutionWinner,
  LwwLocalWinOperationKind,
  LwwResolutionPartitionOptions,
  LwwResolutionPartitions,
  LwwResolvedConflict,
} from './conflict-resolution';

// Entity-registry contracts.
export {
  getEntityConfig,
  getPayloadKey,
  isAdapterEntity,
  isSingletonEntity,
  isMapEntity,
  isArrayEntity,
  isVirtualEntity,
  getAllPayloadKeys,
} from './entity-registry.types';
export type {
  EntityStoragePattern,
  BaseEntity,
  EntityDictionary,
  StateSelector,
  PropsStateSelector,
  SelectByIdFactory,
  EntityUpdateLike,
  EntityAdapterLike,
  SelectById,
  EntityConfig,
  EntityRegistry,
} from './entity-registry.types';

// Privacy-aware logger port.
export { NOOP_SYNC_LOGGER, toSyncLogError } from './sync-logger';
export type { SyncLogError, SyncLogMeta, SyncLogger } from './sync-logger';

// Entity key encoding helpers.
export { toEntityKey, parseEntityKey } from './entity-key.util';

// Sync state corruption error.
export { SyncStateCorruptedError } from './sync-state-corrupted.error';
