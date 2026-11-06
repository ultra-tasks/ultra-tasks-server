import { describe, expect, it } from 'vitest';
import {
  baselineFromHeads,
  personalChanges,
  personalRecords,
  restorePersonal,
} from '../src/personal-records';
import {
  sharedTaskFromPersonal,
  validateSharedRecord,
  validateSharedHierarchy,
} from '../src/shared-project';
import { mergeRecord } from '../src/sync-merge';
import type { PlainHead } from '../src/sync-types';

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
