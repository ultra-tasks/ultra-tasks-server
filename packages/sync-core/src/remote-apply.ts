import type { ApplyOperationsResult } from './apply.types';
import type { Operation } from './operation.types';
import type { OperationApplyPort } from './ports';

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
  applier: OperationApplyPort<TOperation>;
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
 * 2. apply only the newly appended ops through the host applier;
 * 3. mark successfully applied seqs;
 * 4. merge applied remote vector clocks;
 * 5. retain only the newest applied full-state ops when configured;
 * 6. mark the failed op and remaining ops as failed on partial error — their
 *    reducer effects committed with the bulk dispatch; only their archive side
 *    effects are outstanding (see ApplyOperationsResult.failedOp).
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

  const applyResult = await applier.applyOperations(appendResult.writtenOps, {
    onReducersCommitted: async (reducerCommittedOps) => {
      const reducerCommittedSeqs = reducerCommittedOps
        .map((op) => opIdToSeq.get(op.id))
        .filter((seq): seq is number => seq !== undefined);
      if (reducerCommittedSeqs.length !== reducerCommittedOps.length) {
        throw new Error(
          'applyRemoteOperations: reducer commit contained an operation outside the appended batch.',
        );
      }
      await store.markArchivePending(reducerCommittedSeqs);
      await store.mergeRemoteOpClocks(reducerCommittedOps);
    },
  });
  if (applyResult.failedOp && !opIdToSeq.has(applyResult.failedOp.op.id)) {
    throw new Error(
      `applyRemoteOperations: applier reported unknown failed op ${applyResult.failedOp.op.id}.`,
    );
  }
  const appliedSeqs = applyResult.appliedOps
    .map((op) => opIdToSeq.get(op.id))
    .filter((seq): seq is number => seq !== undefined);

  let clearedFullStateOpCount = 0;

  if (appliedSeqs.length > 0) {
    await store.markApplied(appliedSeqs);

    const appliedFullStateOpIds = applyResult.appliedOps
      .filter(isFullStateOperation)
      .map((op) => op.id);

    if (appliedFullStateOpIds.length > 0) {
      clearedFullStateOpCount =
        await store.clearFullStateOpsExcept(appliedFullStateOpIds);
    }
  }

  const failedOpIds = applyResult.failedOp ? [applyResult.failedOp.op.id] : [];

  if (failedOpIds.length > 0) {
    await store.markFailed(failedOpIds);
  }

  return {
    appendedOps: appendResult.writtenOps,
    skippedCount: appendResult.skippedCount,
    appliedOps: applyResult.appliedOps,
    appliedSeqs,
    clearedFullStateOpCount,
    failedOp: applyResult.failedOp,
    failedOpIds,
  };
};
