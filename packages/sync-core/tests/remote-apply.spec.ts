import { describe, expect, it, vi } from 'vitest';
import { applyRemoteOperations } from '../src/remote-apply';
import type { RemoteOperationApplyStorePort } from '../src/remote-apply';
import type { Operation, OperationApplyPort } from '../src';

const createOperation = (id: string, opType = 'UPD'): Operation<string> => ({
  id,
  actionType: '[Test] Action',
  opType,
  entityType: 'TASK',
  entityId: id,
  payload: {},
  clientId: 'client-1',
  vectorClock: { client1: 1 },
  timestamp: 1,
  schemaVersion: 1,
});

const createStore = (appendResult: {
  seqs: number[];
  writtenOps: Operation<string>[];
  skippedCount: number;
}): RemoteOperationApplyStorePort<Operation<string>> => ({
  appendBatchSkipDuplicates: vi.fn().mockResolvedValue(appendResult),
  markArchivePending: vi.fn().mockResolvedValue(undefined),
  markApplied: vi.fn().mockResolvedValue(undefined),
  markFailed: vi.fn().mockResolvedValue(undefined),
  mergeRemoteOpClocks: vi.fn().mockResolvedValue(undefined),
  clearFullStateOpsExcept: vi.fn().mockResolvedValue(0),
});

const createApplier = (
  result: Awaited<ReturnType<OperationApplyPort<Operation<string>>['applyOperations']>>,
): OperationApplyPort<Operation<string>> => ({
  applyOperations: vi.fn(async (ops, options) => {
    await options?.onReducersCommitted?.(ops);
    return result;
  }),
});

describe('applyRemoteOperations', () => {
  it('appends remote ops as pending and applies only written ops', async () => {
    const op1 = createOperation('op-1');
    const op2 = createOperation('op-2');
    const store = createStore({ seqs: [10], writtenOps: [op2], skippedCount: 1 });
    const applier = createApplier({ appliedOps: [op2] });

    const result = await applyRemoteOperations({
      ops: [op1, op2],
      store,
      applier,
    });

    expect(store.appendBatchSkipDuplicates).toHaveBeenCalledWith([op1, op2], 'remote', {
      pendingApply: true,
    });
    expect(applier.applyOperations).toHaveBeenCalledWith(
      [op2],
      jasmineLikeObjectContainingFunction(),
    );
    expect(store.markArchivePending).toHaveBeenCalledWith([10]);
    expect(store.markApplied).toHaveBeenCalledWith([10]);
    expect(store.mergeRemoteOpClocks).toHaveBeenCalledWith([op2]);
    expect(result).toEqual({
      appendedOps: [op2],
      skippedCount: 1,
      appliedOps: [op2],
      appliedSeqs: [10],
      clearedFullStateOpCount: 0,
      failedOpIds: [],
    });
  });

  it('does not apply when every incoming op is skipped as a duplicate', async () => {
    const op = createOperation('op-1');
    const store = createStore({ seqs: [], writtenOps: [], skippedCount: 1 });
    const applier = createApplier({ appliedOps: [] });

    const result = await applyRemoteOperations({ ops: [op], store, applier });

    expect(applier.applyOperations).not.toHaveBeenCalled();
    expect(store.markApplied).not.toHaveBeenCalled();
    expect(store.mergeRemoteOpClocks).not.toHaveBeenCalled();
    expect(result).toEqual({
      appendedOps: [],
      skippedCount: 1,
      appliedOps: [],
      appliedSeqs: [],
      clearedFullStateOpCount: 0,
      failedOpIds: [],
    });
  });

  it('clears older full-state ops after successfully applying a full-state op', async () => {
    const fullStateOp = createOperation('sync-import-1', 'SYNC_IMPORT');
    const store = createStore({
      seqs: [1],
      writtenOps: [fullStateOp],
      skippedCount: 0,
    });
    vi.mocked(store.clearFullStateOpsExcept).mockResolvedValue(3);
    const applier = createApplier({ appliedOps: [fullStateOp] });

    const result = await applyRemoteOperations({
      ops: [fullStateOp],
      store,
      applier,
      isFullStateOperation: (op) => op.opType === 'SYNC_IMPORT',
    });

    expect(store.clearFullStateOpsExcept).toHaveBeenCalledWith(['sync-import-1']);
    expect(result.clearedFullStateOpCount).toBe(3);
  });

  it('cleanup preserves a batch full-state op whose archive handling failed (archive_pending)', async () => {
    // Both imports reducer-committed; the LATER one failed only its archive
    // side effects. Cleanup keyed on the applied one must not delete the
    // archive_pending entry, or markFailed misses it and the change is lost
    // from the next startup replay.
    const appliedImport = createOperation('sync-import-1', 'SYNC_IMPORT');
    const failedImport = createOperation('sync-import-2', 'SYNC_IMPORT');
    const error = new Error('archive failure');
    const store = createStore({
      seqs: [1, 2],
      writtenOps: [appliedImport, failedImport],
      skippedCount: 0,
    });
    const applier = createApplier({
      appliedOps: [appliedImport],
      failedOp: { op: failedImport, error },
    });

    await applyRemoteOperations({
      ops: [appliedImport, failedImport],
      store,
      applier,
      isFullStateOperation: (op) => op.opType === 'SYNC_IMPORT',
    });

    expect(store.clearFullStateOpsExcept).toHaveBeenCalledWith([
      'sync-import-1',
      'sync-import-2',
    ]);
    expect(store.markFailed).toHaveBeenCalledWith(['sync-import-2']);
  });

  it('checkpoints the whole reducer batch but charges only the attempted archive failure', async () => {
    const op1 = createOperation('op-1');
    const op2 = createOperation('op-2');
    const op3 = createOperation('op-3');
    const error = new Error('archive failure');
    const store = createStore({
      seqs: [1, 2, 3],
      writtenOps: [op1, op2, op3],
      skippedCount: 0,
    });
    const applier = createApplier({
      appliedOps: [op1],
      failedOp: { op: op2, error },
    });

    const result = await applyRemoteOperations({
      ops: [op1, op2, op3],
      store,
      applier,
    });

    expect(store.markApplied).toHaveBeenCalledWith([1]);
    expect(store.markArchivePending).toHaveBeenCalledWith([1, 2, 3]);
    expect(store.mergeRemoteOpClocks).toHaveBeenCalledWith([op1, op2, op3]);
    expect(store.markFailed).toHaveBeenCalledWith(['op-2']);
    expect(result.failedOp).toEqual({ op: op2, error });
    expect(result.failedOpIds).toEqual(['op-2']);
  });

  it('rejects an applier result whose failed op is not in the appended batch', async () => {
    const op1 = createOperation('op-1');
    const unknownFailedOp = createOperation('unknown-failed-op');
    const store = createStore({ seqs: [1], writtenOps: [op1], skippedCount: 0 });
    const applier = createApplier({
      appliedOps: [],
      failedOp: { op: unknownFailedOp, error: new Error('unexpected') },
    });

    await expect(applyRemoteOperations({ ops: [op1], store, applier })).rejects.toThrow(
      'unknown-failed-op',
    );
    expect(store.markFailed).not.toHaveBeenCalled();
  });

  it('fails closed when the applier ignores the reducer-commit callback', async () => {
    const op = createOperation('op-1');
    const store = createStore({ seqs: [1], writtenOps: [op], skippedCount: 0 });
    const applier: OperationApplyPort<Operation<string>> = {
      applyOperations: vi.fn().mockResolvedValue({ appliedOps: [op] }),
    };

    await expect(applyRemoteOperations({ ops: [op], store, applier })).rejects.toThrow(
      'reducer-commit callback',
    );
    expect(store.markApplied).not.toHaveBeenCalled();
  });

  it('fails closed when the reducer-commit callback omits an appended op', async () => {
    const op1 = createOperation('op-1');
    const op2 = createOperation('op-2');
    const store = createStore({
      seqs: [1, 2],
      writtenOps: [op1, op2],
      skippedCount: 0,
    });
    const applier: OperationApplyPort<Operation<string>> = {
      applyOperations: vi.fn(async (_ops, options) => {
        await options?.onReducersCommitted?.([op1]);
        return { appliedOps: [op1, op2] };
      }),
    };

    await expect(
      applyRemoteOperations({ ops: [op1, op2], store, applier }),
    ).rejects.toThrow('entire appended batch');
    expect(store.markApplied).not.toHaveBeenCalled();
  });

  it('fails closed when the reducer-commit callback is invoked twice', async () => {
    const op = createOperation('op-1');
    const store = createStore({ seqs: [1], writtenOps: [op], skippedCount: 0 });
    const applier: OperationApplyPort<Operation<string>> = {
      applyOperations: vi.fn(async (ops, options) => {
        await options?.onReducersCommitted?.(ops);
        await options?.onReducersCommitted?.(ops);
        return { appliedOps: ops };
      }),
    };

    await expect(applyRemoteOperations({ ops: [op], store, applier })).rejects.toThrow(
      'exactly once',
    );
    expect(store.markApplied).not.toHaveBeenCalled();
  });
});

const jasmineLikeObjectContainingFunction = (): object =>
  expect.objectContaining({ onReducersCommitted: expect.any(Function) });
