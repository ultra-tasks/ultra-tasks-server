import { describe, expect, it } from 'vitest';
import {
  baselineFromHeads,
  personalChanges,
  personalRecords,
  preparePersonalTimeRebase,
  rebasePersonalTimeChange,
  restorePersonal,
} from '../src/personal-records';
import {
  sharedTaskFromPersonal,
  validateSharedRecord,
  validateSharedHierarchy,
} from '../src/shared-project';
import { mergeRecord } from '../src/sync-merge';
import type { Intent, PlainHead } from '../src/sync-types';

const heads = (
  records: Awaited<ReturnType<typeof personalRecords>>['records'],
): Record<string, PlainHead> =>
  Object.fromEntries(
    Object.values(records).map((record) => [
      record.entityId,
      { ...record, revision: 1, deleted: false },
    ]),
  );
const FIXTURE = {
  task: {
    ids: ['one'],
    currentTaskId: null,
    entities: {
      one: {
        id: 'one',
        title: 'Private',
        notes: 'private notes',
        timeSpentOnDay: { ['2026-11-05']: 1000 },
        timeSpent: 1000,
      },
    },
  },
  project: { ids: ['p'], entities: { p: { id: 'p', title: 'P', taskIds: ['one'] } } },
  archiveYoung: {
    task: { ids: [], entities: {} },
    timeTracking: { project: {}, tag: {} },
  },
  archiveOld: {
    task: {
      ids: ['old'],
      entities: {
        old: {
          id: 'old',
          title: 'Old',
          timeSpentOnDay: { ['2025-01-01']: 2500 },
          timeSpent: 2500,
        },
      },
    },
    timeTracking: { project: {}, tag: {} },
  },
  globalConfig: { sync: { isEnabled: false }, misc: { language: 'en' } },
  pluginUserData: { plugin: { opaque: { custom: ['nested', 1, false] } } },
  reminders: [{ id: 'reminder', remindAt: 9000 }],
};
const source = (): typeof FIXTURE => structuredClone(FIXTURE);
const DAY = '2026-11-05';
const archived = (value = source()): Record<string, unknown> => ({
  ...value,
  task: { ...value.task, ids: [], entities: {} },
  archiveYoung: { ...value.archiveYoung, task: value.task },
});
const archivedTime = (records: Record<string, PlainHead>): number =>
  (restorePersonal(records).archiveYoung as { task: typeof FIXTURE.task }).task.entities
    .one.timeSpent;
const intentFrom = (
  before: Awaited<ReturnType<typeof personalRecords>>,
  after: Awaited<ReturnType<typeof personalRecords>>,
): Intent => {
  const base = heads(before.records);
  return {
    id: 'pending-archive',
    changes: personalChanges(before, after).map((change) => ({
      ...change,
      base: base[change.entityId] ?? null,
      deleted: change.deleted ?? false,
    })),
  };
};
describe('personal record inventory and shared boundary', () => {
  it('merges independent ID additions while preserving an overlapping reorder as a conflict', () => {
    expect(mergeRecord(['a'], ['a', 'b'], ['a', 'c'])).toEqual({
      value: ['a', 'c', 'b'],
      conflict: false,
    });
    expect(mergeRecord(['a', 'b', 'c'], ['b', 'a', 'c'], ['a', 'c', 'b']).conflict).toBe(
      true,
    );
  });
  it('rejects a cycle without rejecting a temporarily unavailable parent reference', () => {
    expect(() =>
      validateSharedHierarchy({
        a: { title: 'a', parentId: 'b' },
        b: { title: 'b', parentId: 'a' },
      }),
    ).toThrow('cycle');
    expect(() =>
      validateSharedHierarchy({ a: { title: 'a', parentId: 'unavailable' } }),
    ).not.toThrow();
  });
  it('round-trips live entities, archives, opaque plugin data, settings, reminders, and tracked time', async () => {
    const original = source();
    const result = await personalRecords(original, 'device-a');
    expect(restorePersonal(heads(result.records))).toEqual(original);
  });
  it('adds independent per-device time buckets without duplicating remote time on the next capture', async () => {
    const original = source();
    const baseline = await personalRecords(original, 'initial');
    const left = source();
    left.task.entities.one.timeSpentOnDay['2026-11-05'] += 2000;
    const right = source();
    right.task.entities.one.timeSpentOnDay['2026-11-05'] += 3000;
    const a = await personalRecords(left, 'left', baseline);
    const b = await personalRecords(right, 'right', baseline);
    const merged = heads({ ...a.records, ...b.records });
    const restored = restorePersonal(merged) as ReturnType<typeof source>;
    expect(restored.task.entities.one.timeSpent).toBe(6000);
    const next = await personalRecords(
      restored,
      'left',
      baselineFromHeads(merged, restored),
    );
    expect(personalChanges(baselineFromHeads(merged, restored), next)).toEqual([]);
  });
  it('records explicit time corrections and never revives a deleted task through its buckets', async () => {
    const initial = await personalRecords(source(), 'initial');
    const corrected = source();
    corrected.task.entities.one.timeSpentOnDay['2026-11-05'] = 300;
    const result = await personalRecords(corrected, 'left', initial);
    const all = heads(result.records);
    expect(
      (restorePersonal(all) as ReturnType<typeof source>).task.entities.one.timeSpent,
    ).toBe(300);
    const taskId = Object.values(all).find(
      (h) => (h.value as { path: string[] }).path?.join('/') === 'task/entities/one',
    )!.entityId;
    all[taskId].deleted = true;
    expect(
      (restorePersonal(all) as ReturnType<typeof source>).task.entities.one,
    ).toBeUndefined();
  });
  it('moves each counter with its task and recaptures that same ID after an edit', async () => {
    const baseline = await personalRecords(source(), 'initial');
    const next = await personalRecords(archived(), 'archive', baseline);
    const old = Object.values(baseline.records).find((record) =>
      (record.value as { path: string[] }).path.includes(DAY),
    )!;
    expect(next.records[old.entityId].value).toEqual({
      path: ['archiveYoung', 'task', 'entities', 'one', 'timeSpentOnDay', DAY],
      deviceId: 'legacy-baseline',
      positive: 1000,
      negative: 0,
    });
    expect(archivedTime(heads(next.records))).toBe(1000);

    const edit = source();
    edit.task.entities.one.timeSpentOnDay[DAY] += 500;
    const adjusted = await personalRecords(edit, 'timer', baseline);
    const newBucket = intentFrom(baseline, adjusted).changes[0];
    const committed = heads({ ...next.records, [newBucket.entityId]: newBucket });
    expect(archivedTime(committed)).toBe(1500);
    const received = restorePersonal(committed);
    const recaptured = await personalRecords(
      received,
      'timer',
      baselineFromHeads(committed, received),
    );
    expect(recaptured.records[newBucket.entityId].value).toEqual({
      path: ['archiveYoung', 'task', 'entities', 'one', 'timeSpentOnDay', DAY],
      deviceId: 'timer',
      positive: 500,
      negative: 0,
    });
    expect(archivedTime(heads(recaptured.records))).toBe(1500);
  });
  it('carries a remotely introduced bucket into the pending archive transaction', async () => {
    const baseline = await personalRecords(source(), 'initial');
    const archivedLocally = await personalRecords(archived(), 'archive', baseline);
    const intent = intentFrom(baseline, archivedLocally);
    const edit = source();
    edit.task.entities.one.timeSpentOnDay[DAY] += 500;
    const adjusted = await personalRecords(edit, 'timer', baseline);
    const [newBucket] = intentFrom(baseline, adjusted).changes;
    const remote = heads(adjusted.records);

    preparePersonalTimeRebase(remote, [intent]);

    expect(intent.changes).toContainEqual({
      entityId: newBucket.entityId,
      entityType: 'personal.time',
      deleted: false,
      base: remote[newBucket.entityId],
      value: {
        path: ['archiveYoung', 'task', 'entities', 'one', 'timeSpentOnDay', DAY],
        deviceId: 'timer',
        positive: 500,
        negative: 0,
      },
    });
  });
  it('preserves the carried counter if an archive publishes the destination before removing the source', async () => {
    const initial = await personalRecords(source(), 'initial');
    const edit = source();
    edit.task.entities.one.timeSpentOnDay[DAY] += 500;
    const tracked = await personalRecords(edit, 'timer', initial);
    const [bucket] = intentFrom(initial, tracked).changes;
    const moved = await personalRecords(archived(edit), 'archive', tracked);
    const active = Object.values(heads(tracked.records)).find(
      (head) => (head.value as { path: string[] }).path.join('/') === 'task/entities/one',
    )!;
    const intermediate = { ...heads(moved.records), [active.entityId]: active };
    const before = restorePersonal(intermediate) as {
      task: typeof FIXTURE.task;
      archiveYoung: { task: typeof FIXTURE.task };
    };
    const next = structuredClone(before);
    next.task.entities.one.timeSpentOnDay[DAY] = 250;
    next.archiveYoung.task.entities.one.timeSpentOnDay[DAY] += 100;
    const captured = await personalRecords(
      next,
      'timer',
      baselineFromHeads(intermediate, before),
    );

    expect(captured.records[bucket.entityId].value).toEqual({
      path: ['archiveYoung', 'task', 'entities', 'one', 'timeSpentOnDay', DAY],
      deviceId: 'timer',
      positive: 850,
      negative: 0,
    });
    expect(archivedTime(heads(captured.records))).toBe(1850);
  });
  it('carries only the pending correction when a released client archives and folds old time', async () => {
    const initial = await personalRecords(source(), 'initial');
    const prior = source();
    prior.task.entities.one.timeSpentOnDay[DAY] += 500;
    const baseline = await personalRecords(prior, 'timer', initial);
    const corrected = source();
    corrected.task.entities.one.timeSpentOnDay[DAY] = 1250;
    const edit = await personalRecords(corrected, 'timer', baseline);
    const pending = intentFrom(baseline, edit);
    const [change] = pending.changes;
    const legacyArchive = await personalRecords(archived(prior), 'initial');
    const remote = heads(legacyArchive.records);
    const deleted = { ...change.base!, revision: 2, value: null, deleted: true };
    remote[change.entityId] = deleted;

    const locations = preparePersonalTimeRebase(remote, [pending]);
    rebasePersonalTimeChange(change, deleted, deleted, locations);

    expect(change.base).toBe(deleted);
    expect(change.restore).toBe(true);
    expect(change.value).toEqual({
      path: ['archiveYoung', 'task', 'entities', 'one', 'timeSpentOnDay', DAY],
      deviceId: 'timer',
      positive: 0,
      negative: 250,
      foldedTime: {
        path: ['task', 'entities', 'one', 'timeSpentOnDay', DAY],
        elapsed: 500,
      },
    });
    const committed = { ...remote, [change.entityId]: { ...change, revision: 3 } };
    expect(archivedTime(committed)).toBe(1250);
    const applied = restorePersonal(committed) as {
      archiveYoung: { task: typeof FIXTURE.task };
    };
    const old = baselineFromHeads(committed, applied);
    const edited = structuredClone(applied);
    edited.archiveYoung.task.entities.one.timeSpentOnDay[DAY] += 250;
    const captured = await personalRecords(edited, 'timer', old);
    expect(captured.records[change.entityId].value).toMatchObject({
      positive: 250,
      negative: 250,
      foldedTime: {
        path: ['task', 'entities', 'one', 'timeSpentOnDay', DAY],
        elapsed: 500,
      },
    });
    expect(archivedTime(heads(captured.records))).toBe(1500);
  });
  it('uses an explicit sharing allowlist and excludes descriptions unless selected', () => {
    const task = {
      title: 'Title',
      notes: 'private text',
      projectId: 'p',
      timeSpent: 8000,
      tagIds: ['private'],
      dueDay: '2026-11-06',
      deadlineDay: '2026-11-07',
      issueProviderId: 'secret',
    };
    expect(sharedTaskFromPersonal(task)).toEqual({
      title: 'Title',
      isDone: false,
      deadlineDay: '2026-11-07',
    });
    expect(sharedTaskFromPersonal(task, true).description).toBe('private text');
    expect(() =>
      validateSharedRecord('shared.task', { title: 'x', timeSpent: 12 }),
    ).toThrow('Invalid shared fields');
    expect(() =>
      validateSharedRecord('shared.task', {
        title: 'x',
        description: { malicious: true },
      }),
    ).toThrow('Invalid shared text');
  });
  it('rejects prototype paths from another client instead of modifying application objects', () => {
    const hostile: PlainHead = {
      entityId: 'hostile',
      entityType: 'personal.document',
      revision: 1,
      deleted: false,
      value: { path: ['task', '__proto__', 'polluted'], data: true },
    };
    expect(() => restorePersonal({ hostile })).toThrow('Malformed personal document');
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});
