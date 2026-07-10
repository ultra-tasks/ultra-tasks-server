import type { ApplyOperationsResult } from './apply.types';
import type { Operation } from './operation.types';
import type { ReducerCommitAwareOperationApplyPort } from './ports';

export interface RemoteOperationAppendResult<
  TOperation extends Operation<string> = Operation,
> {
  seqs: number[];
  writtenOps: TOperation[];
  skippedCount: number;
}

/**
 * Store methods needed by the generic remote-apply coordinator.
 *
 * This stays narrower than a full operation-log database service and only
 * represents the crash-safety transitions around applying remote operations.
 */
export interface RemoteOperationApplyStorePort<
  TOperation extends Operation<string> = Operation,
> {
  appendBatchSkipDuplicates(
    ops: TOperation[],
    source: 'remote',
    options: { pendingApply: true },
  ): Promise<RemoteOperationAppendResult<TOperation>>;
  markArchivePending(seqs: number[]): Promise<void>;
  markApplied(seqs: number[]): Promise<void>;
  markFailed(opIds: string[]): Promise<void>;
  mergeRemoteOpClocks(ops: TOperation[]): Promise<void>;
  clearFullStateOpsExcept(excludeIds: string[]): Promise<number>;
}

export interface ApplyRemoteOperationsOptions<
  TOperation extends Operation<string> = Operation,
> {
  ops: TOperation[];
  store: RemoteOperationApplyStorePort<TOperation>;
  applier: ReducerCommitAwareOperationApplyPort<TOperation>;
  isFullStateOperation?: (op: TOperation) => boolean;
}

export interface RemoteApplyOperationsResult<
  TOperation extends Operation<string> = Operation,
> {
  appendedOps: TOperation[];
  skippedCount: number;
  appliedOps: TOperation[];
  appliedSeqs: number[];
  clearedFullStateOpCount: number;
  failedOp?: ApplyOperationsResult<TOperation>['failedOp'];
  failedOpIds: string[];
}

const emptyRemoteApplyResult = <
  TOperation extends Operation<string>,
>(): RemoteApplyOperationsResult<TOperation> => ({
  appendedOps: [],
  skippedCount: 0,
  appliedOps: [],
  appliedSeqs: [],
  clearedFullStateOpCount: 0,
  failedOpIds: [],
});

/**
 * Applies remote operations through host ports and records crash-safety state.
 *
 * Host apps keep framework-specific dispatch, storage, diagnostics, validation,
 * and user notifications outside the package. This coordinator only enforces
 * the generic ordering:
 *
 * 1. append incoming remote ops as pending, skipping duplicates atomically;
 * 2. bulk-apply only the newly appended ops through the host applier;
 * 3. at reducer commit, mark the whole batch archive_pending and merge all
 *    reducer-committed vector clocks before archive side effects begin;
 * 4. mark archive-complete seqs applied;
 * 5. after applying a full-state op, clear older full-state ops while
 *    retaining every full-state op of this batch (incl. archive_pending);
 * 6. mark only the attempted archive failure as failed; unattempted successors
 *    remain archive_pending for ordered startup recovery.
 */
export const applyRemoteOperations = async <
  TOperation extends Operation<string> = Operation,
>({
  ops,
  store,
  applier,
  isFullStateOperation = () => false,
}: ApplyRemoteOperationsOptions<TOperation>): Promise<
  RemoteApplyOperationsResult<TOperation>
> => {
  if (ops.length === 0) {
    return emptyRemoteApplyResult();
  }

  const appendResult = await store.appendBatchSkipDuplicates(ops, 'remote', {
    pendingApply: true,
  });

  if (appendResult.writtenOps.length === 0) {
    return {
      ...emptyRemoteApplyResult<TOperation>(),
      skippedCount: appendResult.skippedCount,
    };
  }

  const opIdToSeq = new Map<string, number>();
  appendResult.writtenOps.forEach((op, index) => {
    const seq = appendResult.seqs[index];
    if (seq !== undefined) {
      opIdToSeq.set(op.id, seq);
    }
  });

  let reducerCommitCallbackCount = 0;
  let reducerCommitCallbackError: Error | undefined;
  let reducerCommitPromise: Promise<void> | undefined;
  let applyResult: ApplyOperationsResult<TOperation>;
  try {
    applyResult = await applier.applyOperations(appendResult.writtenOps, {
      onReducersCommitted: (reducerCommittedOps) => {
        reducerCommitCallbackCount++;
        if (reducerCommitCallbackCount !== 1) {
          reducerCommitCallbackError = new Error(
            'applyRemoteOperations: reducer-commit callback must be invoked exactly once.',
          );
          throw reducerCommitCallbackError;
        }

        const isEntireAppendedBatch =
          reducerCommittedOps.length === appendResult.writtenOps.length &&
          reducerCommittedOps.every(
            (op, index) => op.id === appendResult.writtenOps[index]?.id,
          );
        if (!isEntireAppendedBatch) {
          reducerCommitCallbackError = new Error(
            'applyRemoteOperations: reducer-commit callback must contain the entire appended batch in order.',
          );
          throw reducerCommitCallbackError;
        }

        reducerCommitPromise = (async () => {
          const reducerCommittedSeqs = appendResult.writtenOps
            .map((op) => opIdToSeq.get(op.id))
            .filter((seq): seq is number => seq !== undefined);
          if (reducerCommittedSeqs.length !== appendResult.writtenOps.length) {
            throw new Error(
              'applyRemoteOperations: reducer commit contained an operation outside the appended batch.',
            );
          }
          await store.markArchivePending(reducerCommittedSeqs);
          await store.mergeRemoteOpClocks(appendResult.writtenOps);
        })();
        return reducerCommitPromise;
      },
    });
  } catch (applyError) {
    // A valid first callback may already have started durable bookkeeping before
    // a duplicate callback (or another applier error) throws. Observe that
    // promise before propagating so it cannot become an unhandled rejection.
    if (reducerCommitPromise) {
      await reducerCommitPromise;
    }
    throw applyError;
  }
  if (reducerCommitCallbackError) {
    if (reducerCommitPromise) {
      await reducerCommitPromise;
    }
    throw reducerCommitCallbackError;
  }
  if (reducerCommitCallbackCount !== 1 || reducerCommitPromise === undefined) {
    throw new Error(
      'applyRemoteOperations: applier did not invoke the reducer-commit callback.',
    );
  }
  // Also await host bookkeeping when an applier invoked the callback without
  // awaiting its returned promise. Pending ops must never be marked applied
  // before the reducer/archive checkpoint is durable.
  await reducerCommitPromise;

  const appliedOpCount = applyResult.appliedOps.length;
  const hasExactAppliedPrefix =
    appliedOpCount <= appendResult.writtenOps.length &&
    applyResult.appliedOps.every(
      (op, index) => op.id === appendResult.writtenOps[index]?.id,
    );
  if (!hasExactAppliedPrefix) {
    throw new Error(
      'applyRemoteOperations: applied operations must be the exact ordered prefix of the appended batch.',
    );
  }

  const expectedFailedOp = appendResult.writtenOps[appliedOpCount];
  if (
    (applyResult.failedOp && applyResult.failedOp.op.id !== expectedFailedOp?.id) ||
    (!applyResult.failedOp && expectedFailedOp !== undefined)
  ) {
    const reportedFailedOpId = applyResult.failedOp?.op.id ?? 'none';
    const expectedFailedOpId = expectedFailedOp?.id ?? 'none';
    throw new Error(
      'applyRemoteOperations: applier must report the failed operation immediately after the applied prefix. ' +
        `Reported ${reportedFailedOpId}; expected ${expectedFailedOpId}.`,
    );
  }

  const authoritativeAppliedOps = appendResult.writtenOps.slice(0, appliedOpCount);
  const authoritativeFailedOp = applyResult.failedOp
    ? {
        op: expectedFailedOp!,
        error: applyResult.failedOp.error,
      }
    : undefined;
  const appliedSeqs = authoritativeAppliedOps
    .map((op) => opIdToSeq.get(op.id))
    .filter((seq): seq is number => seq !== undefined);

  let clearedFullStateOpCount = 0;

  if (appliedSeqs.length > 0) {
    await store.markApplied(appliedSeqs);

    const appliedFullStateOpIds = authoritativeAppliedOps
      .filter(isFullStateOperation)
      .map((op) => op.id);

    if (appliedFullStateOpIds.length > 0) {
      // Exclude every full-state op of THIS batch, not only the applied ones:
      // a later full-state op whose reducers committed but whose archive
      // handling failed is still archive_pending/failed and must survive
      // cleanup so the retry path can finish it. Deleting it here would let
      // markFailed miss it and lose a change already visible at runtime on
      // the next startup replay.
      const batchFullStateOpIds = appendResult.writtenOps
        .filter(isFullStateOperation)
        .map((op) => op.id);
      clearedFullStateOpCount = await store.clearFullStateOpsExcept(batchFullStateOpIds);
    }
  }

  const failedOpIds = authoritativeFailedOp ? [authoritativeFailedOp.op.id] : [];

  if (failedOpIds.length > 0) {
    await store.markFailed(failedOpIds);
  }

  return {
    appendedOps: appendResult.writtenOps,
    skippedCount: appendResult.skippedCount,
    appliedOps: authoritativeAppliedOps,
    appliedSeqs,
    clearedFullStateOpCount,
    failedOp: authoritativeFailedOp,
    failedOpIds,
  };
};
