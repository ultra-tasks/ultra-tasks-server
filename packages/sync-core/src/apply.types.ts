import type { Operation } from './operation.types';

/**
 * Result of applying a batch of operations.
 *
 * Allows callers to handle partial success scenarios where some operations
 * were applied before an error occurred.
 */
export interface ApplyOperationsResult<TOperation extends Operation<string> = Operation> {
  /** Operations that were successfully applied. */
  appliedOps: TOperation[];

  /**
   * If an error occurred, this contains the failed operation and the error.
   * The failed op and the operations after it in the batch did NOT complete
   * their archive side effects — but their reducer effects DID commit: the
   * bulk dispatch is all-or-nothing and runs before archive handling, so
   * archive side effects are the only per-op failure point. Retry paths must
   * therefore use `skipReducerDispatch` to avoid double-applying reducers.
   */
  failedOp?: {
    op: TOperation;
    error: Error;
  };
}

export interface ApplyOperationsOptions {
  /**
   * When true, skip side effects that would normally fire on first application
   * (e.g. writing to archive storage) — used when replaying already-persisted
   * local operations during hydration.
   */
  isLocalHydration?: boolean;

  /**
   * When true, skip the bulk reducer dispatch and run only the post-dispatch
   * archive side effects. Used to retry operations whose reducer effects
   * already committed in an earlier batch (see `failedOp`): re-dispatching on
   * retry would double-apply additive reducers such as time-tracking deltas
   * and counter increments.
   */
  skipReducerDispatch?: boolean;
}
