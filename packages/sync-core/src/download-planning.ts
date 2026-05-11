export interface PlanDownloadGapResetOptions {
  gapDetected?: boolean;
  hasResetForGap: boolean;
}

export interface DownloadGapResetPlan {
  shouldReset: boolean;
}

/**
 * Plans whether a download loop should reset to sequence 0 after a server gap.
 * A single reset is allowed per download session to avoid infinite loops when a
 * provider keeps reporting a gap after reset.
 */
export const planDownloadGapReset = ({
  gapDetected,
  hasResetForGap,
}: PlanDownloadGapResetOptions): DownloadGapResetPlan => ({
  shouldReset: !!gapDetected && !hasResetForGap,
});

export type DownloadFullStateUploadReason =
  | 'gap-empty-server'
  | 'empty-server-with-synced-ops'
  | 'none';

export interface PlanDownloadFullStateUploadOptions {
  currentNeedsFullStateUpload: boolean;
  hasResetForGap: boolean;
  downloadedOpCount: number;
  finalLatestSeq: number;
  hasSnapshotState: boolean;
  hasSyncedOps?: boolean;
}

export interface DownloadFullStateUploadPlan {
  needsFullStateUpload: boolean;
  reason: DownloadFullStateUploadReason;
  shouldCheckHasSyncedOps: boolean;
}

/**
 * Plans whether an empty remote should be seeded with a full-state upload.
 *
 * The host supplies `hasSyncedOps` only when this helper asks for it, so app
 * code can avoid unnecessary IndexedDB reads on normal non-empty downloads and
 * when gap-based migration detection already decided the result.
 */
export const planDownloadFullStateUpload = ({
  currentNeedsFullStateUpload,
  hasResetForGap,
  downloadedOpCount,
  finalLatestSeq,
  hasSnapshotState,
  hasSyncedOps,
}: PlanDownloadFullStateUploadOptions): DownloadFullStateUploadPlan => {
  if (currentNeedsFullStateUpload) {
    return {
      needsFullStateUpload: true,
      reason: 'none',
      shouldCheckHasSyncedOps: false,
    };
  }

  const isEmptyServer =
    downloadedOpCount === 0 && finalLatestSeq === 0 && !hasSnapshotState;

  if (hasResetForGap && isEmptyServer) {
    return {
      needsFullStateUpload: true,
      reason: 'gap-empty-server',
      shouldCheckHasSyncedOps: false,
    };
  }

  if (!isEmptyServer) {
    return {
      needsFullStateUpload: false,
      reason: 'none',
      shouldCheckHasSyncedOps: false,
    };
  }

  if (hasSyncedOps === undefined) {
    return {
      needsFullStateUpload: false,
      reason: 'none',
      shouldCheckHasSyncedOps: true,
    };
  }

  return {
    needsFullStateUpload: hasSyncedOps,
    reason: hasSyncedOps ? 'empty-server-with-synced-ops' : 'none',
    shouldCheckHasSyncedOps: false,
  };
};

export interface PlanDownloadedDataEncryptionStateOptions {
  sawAnyOps: boolean;
  sawEncryptedOp: boolean;
}

/**
 * Detects whether all observed remote data was unencrypted. Hosts use this to
 * notice when another client disabled encryption.
 */
export const planDownloadedDataEncryptionState = ({
  sawAnyOps,
  sawEncryptedOp,
}: PlanDownloadedDataEncryptionStateOptions): {
  serverHasOnlyUnencryptedData: boolean;
} => ({
  serverHasOnlyUnencryptedData: sawAnyOps && !sawEncryptedOp,
});
