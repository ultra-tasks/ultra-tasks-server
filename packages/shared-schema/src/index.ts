// Schema version constants
export {
  CURRENT_SCHEMA_VERSION,
  MIN_SUPPORTED_SCHEMA_VERSION,
  MAX_VERSION_SKIP,
} from './schema-version.js';

// Types
export type {
  OperationLike,
  SchemaMigration,
  MigrationResult,
  MigratableStateCache,
} from './migration.types.js';

// Migration functions
export {
  migrateState,
  migrateOperation,
  migrateOperations,
  stateNeedsMigration,
  operationNeedsMigration,
  validateMigrationRegistry,
  getCurrentSchemaVersion,
} from './migrate.js';

// Migration registry (for inspection/debugging)
export { MIGRATIONS } from './migrations/index.js';

// Vector clock types and comparison (shared between client and server)
export type { VectorClock, VectorClockComparison } from './vector-clock.js';
export { compareVectorClocks, mergeVectorClocks } from './vector-clock.js';

// Entity types (shared between client and server)
export type { EntityType } from './entity-types.js';
export { ENTITY_TYPES } from './entity-types.js';
