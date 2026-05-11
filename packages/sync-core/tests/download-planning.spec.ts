import { describe, expect, it } from 'vitest';
import {
  planDownloadFullStateUpload,
  planDownloadGapReset,
  planDownloadedDataEncryptionState,
} from '../src/download-planning';

describe('planDownloadGapReset', () => {
  it('resets once when a gap is detected', () => {
    expect(planDownloadGapReset({ gapDetected: true, hasResetForGap: false })).toEqual({
      shouldReset: true,
    });
  });

  it('does not reset again after a previous gap reset', () => {
    expect(planDownloadGapReset({ gapDetected: true, hasResetForGap: true })).toEqual({
      shouldReset: false,
    });
  });
});

describe('planDownloadFullStateUpload', () => {
  it('requires full-state upload after a gap reset lands on an empty server', () => {
    expect(
      planDownloadFullStateUpload({
        currentNeedsFullStateUpload: false,
        hasResetForGap: true,
        downloadedOpCount: 0,
        finalLatestSeq: 0,
        hasSnapshotState: false,
      }),
    ).toEqual({
      needsFullStateUpload: true,
      reason: 'gap-empty-server',
      shouldCheckHasSyncedOps: false,
    });
  });

  it('asks the host to check synced-op history for an empty server without gap reset', () => {
    expect(
      planDownloadFullStateUpload({
        currentNeedsFullStateUpload: false,
        hasResetForGap: false,
        downloadedOpCount: 0,
        finalLatestSeq: 0,
        hasSnapshotState: false,
      }),
    ).toEqual({
      needsFullStateUpload: false,
      reason: 'none',
      shouldCheckHasSyncedOps: true,
    });
  });

  it('requires full-state upload for an empty server when the host has synced ops', () => {
    expect(
      planDownloadFullStateUpload({
        currentNeedsFullStateUpload: false,
        hasResetForGap: false,
        downloadedOpCount: 0,
        finalLatestSeq: 0,
        hasSnapshotState: false,
        hasSyncedOps: true,
      }),
    ).toEqual({
      needsFullStateUpload: true,
      reason: 'empty-server-with-synced-ops',
      shouldCheckHasSyncedOps: false,
    });
  });

  it('does not require full-state upload when a snapshot state exists', () => {
    expect(
      planDownloadFullStateUpload({
        currentNeedsFullStateUpload: false,
        hasResetForGap: true,
        downloadedOpCount: 0,
        finalLatestSeq: 0,
        hasSnapshotState: true,
        hasSyncedOps: true,
      }),
    ).toEqual({
      needsFullStateUpload: false,
      reason: 'none',
      shouldCheckHasSyncedOps: false,
    });
  });
});

describe('planDownloadedDataEncryptionState', () => {
  it('flags only-unencrypted data when ops were observed and none were encrypted', () => {
    expect(
      planDownloadedDataEncryptionState({
        sawAnyOps: true,
        sawEncryptedOp: false,
      }),
    ).toEqual({ serverHasOnlyUnencryptedData: true });
  });

  it('does not flag only-unencrypted data when no ops were observed', () => {
    expect(
      planDownloadedDataEncryptionState({
        sawAnyOps: false,
        sawEncryptedOp: false,
      }),
    ).toEqual({ serverHasOnlyUnencryptedData: false });
  });
});
