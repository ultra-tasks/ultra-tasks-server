export {
  SUPER_SYNC_CLIENT_ID_REGEX as CLIENT_ID_REGEX,
  SUPER_SYNC_MAX_CLIENT_ID_LENGTH as MAX_CLIENT_ID_LENGTH,
} from '@sp/shared-schema';

/**
 * Approximate bytes-per-op used when decrementing `users.storage_used_bytes`
 * during cleanup-deletes. The exact figure would require detoasting every
 * deleted payload via `pg_column_size`, which was the source of the production
 * disk-I/O DoS. Picked as a conservative over-estimate vs the observed median
 * task-op (~150-300 bytes) so the cleanup loop reliably makes progress; drift
 * is reconciled once at the end of `freeStorageForUpload` via a single
 * `updateStorageUsage` scan.
 */
export const APPROX_BYTES_PER_OP = 1024;
