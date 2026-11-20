import { mergeRecord } from './sync-merge';
import type { ConflictDraft, Intent, LocalScope, PlainHead } from './sync-types';

type UploadDraft = Extract<ConflictDraft, { reason: 'upload' }>;

export class UploadBodySizeError extends Error {
  constructor() {
    super('A personal record exceeds the upload limit; local changes remain queued');
  }
}

export const canHoldUpload = (scope: LocalScope): boolean =>
  scope.info.kind === 'personal' && scope.info.state === 'active';

export const withUploadDraft = (
  head: PlainHead | undefined,
  draft: UploadDraft,
): PlainHead | undefined => {
  // Committed deletes and overlapping edits still win. The original stays exportable.
  if (head?.deleted) return head;
  const { value } = mergeRecord(draft.base?.value, draft.value, head?.value);
  return value === undefined
    ? head
    : {
        entityId: draft.entityId,
        entityType: draft.entityType,
        revision: head?.revision ?? 0,
        value,
        deleted: draft.deleted,
      };
};

export const holdRejectedWrites = (
  scope: LocalScope,
  indices: ReadonlySet<number>,
): void => {
  const [intent, ...following] = scope.intents;
  const rejected = new Map<string, Intent['changes'][number]>();
  const kept = intent.changes.filter((change, index) => {
    if (!indices.has(index)) return true;
    rejected.set(change.entityId, change);
    return false;
  });
  const conflicts = scope.conflicts.filter(
    (draft) => draft.reason !== 'upload' || !rejected.has(draft.entityId),
  );
  for (const change of rejected.values())
    conflicts.push({
      ...change,
      id: crypto.randomUUID(),
      reason: 'upload',
      createdAt: Date.now(),
    });

  // A correction already queued behind a rejected edit used the latter as its base.
  // Its next real predecessor is the accepted revision that the rejected edit used.
  const rest = following.map((pending) => ({
    ...pending,
    changes: pending.changes.map((change) => {
      const previous = rejected.get(change.entityId);
      if (!previous) return change;
      rejected.delete(change.entityId);
      return { ...change, base: previous.base };
    }),
  }));
  scope.conflicts = conflicts;
  scope.intents = kept.length ? [{ ...intent, changes: kept }, ...rest] : rest;
  delete scope.uncertain;
  delete scope.uncertainKey;
};
