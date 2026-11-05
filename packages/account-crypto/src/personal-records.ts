import { canonical, fingerprint } from './encoding';
import type { RecordChange } from './sync-client';
import type { PlainHead } from './sync-types';

export const PERSONAL_MODELS = [
  'project',
  'menuTree',
  'globalConfig',
  'planner',
  'boards',
  'note',
  'issueProvider',
  'metric',
  'task',
  'tag',
  'simpleCounter',
  'section',
  'taskRepeatCfg',
  'reminders',
  'timeTracking',
  'pluginUserData',
  'pluginMetadata',
  'archiveYoung',
  'archiveOld',
] as const;
interface DocumentValue {
  path: string[];
  data: unknown;
}
interface TimeValue {
  path: string[];
  deviceId: string;
  positive: number;
  negative: number;
}
export interface PersonalBaseline {
  source: Record<string, unknown>;
  records: Record<string, RecordChange>;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const clean = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const get = (value: unknown, path: string[]): unknown =>
  path.reduce<unknown>((v, key) => (object(v) ? v[key] : undefined), value);
const timeAnchor = (path: string[]): string[] =>
  path.slice(0, path.includes('timeSpentOnDay') ? -2 : -1);
const safePath = (path: unknown): path is string[] =>
  Array.isArray(path) &&
  path.length > 0 &&
  path.length <= 12 &&
  PERSONAL_MODELS.includes(path[0] as (typeof PERSONAL_MODELS)[number]) &&
  path.every(
    (p) =>
      typeof p === 'string' &&
      p.length <= 128 &&
      !['__proto__', 'prototype', 'constructor'].includes(p),
  );
const set = (root: Record<string, unknown>, path: string[], value: unknown): void => {
  let target = root;
  for (const key of path.slice(0, -1)) {
    if (!object(target[key])) target[key] = {};
    target = target[key] as Record<string, unknown>;
  }
  target[path.at(-1)!] = value;
};

/** Every legacy model has an explicit inventory entry. Credentials remain in personal ciphertext. */
export const personalRecords = async (
  snapshot: Record<string, unknown>,
  deviceId: string,
  previous?: PersonalBaseline,
): Promise<PersonalBaseline> => {
  const source = clean(snapshot);
  const records: Record<string, RecordChange> = {};
  const timePaths = new Map<string, { path: string[]; value: number }>();
  const add = async (path: string[], data: unknown): Promise<void> => {
    if (!safePath(path)) throw new Error('Unsupported personal record path');
    const entityId = await fingerprint({ path });
    records[entityId] = {
      entityId,
      entityType: 'personal.document',
      value: { path, data } satisfies DocumentValue,
    };
  };
  const task = async (path: string[], data: unknown): Promise<void> => {
    if (!object(data)) return add(path, data);
    const copy = { ...data };
    if (object(copy.timeSpentOnDay)) {
      for (const [day, value] of Object.entries(copy.timeSpentOnDay)) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new Error('Invalid tracked time');
        const bucketPath = [...path, 'timeSpentOnDay', day];
        timePaths.set(canonical(bucketPath), { path: bucketPath, value });
      }
      copy.timeSpentOnDay = {};
      copy.timeSpent = 0;
    }
    await add(path, copy);
  };
  const slice = async (path: string[], value: unknown): Promise<void> => {
    if (value === undefined) return;
    if (object(value) && object(value.entities) && Array.isArray(value.ids)) {
      const { entities, ...metadata } = value;
      await add(path, { ...metadata, entities: {} });
      for (const [id, entity] of Object.entries(entities))
        if (entity !== undefined) await task([...path, 'entities', id], entity);
    } else if (
      (path[0] === 'timeTracking' || path.includes('timeTracking')) &&
      object(value) &&
      ['s', 'e', 'b', 'bt'].some((key) => Object.hasOwn(value, key))
    ) {
      const copy = { ...value };
      for (const key of ['b', 'bt'])
        if (typeof value[key] === 'number') {
          const bucketPath = [...path, key];
          timePaths.set(canonical(bucketPath), { path: bucketPath, value: value[key] });
          copy[key] = 0;
        }
      await add(path, copy);
    } else if (
      path[0] === 'archiveYoung' ||
      path[0] === 'archiveOld' ||
      path[0] === 'globalConfig' ||
      path[0] === 'timeTracking'
    ) {
      if (object(value) && Object.keys(value).length)
        for (const [key, data] of Object.entries(value))
          await slice([...path, key], data);
      else await add(path, value);
    } else await add(path, value);
  };
  for (const model of PERSONAL_MODELS) await slice([model], source[model]);
  for (const record of Object.values(previous?.records ?? {}))
    if (record.entityType === 'personal.time') {
      const value = record.value as TimeValue;
      if (
        !timePaths.has(canonical(value.path)) &&
        get(source, timeAnchor(value.path)) !== undefined
      )
        timePaths.set(canonical(value.path), { path: value.path, value: 0 });
      if (timePaths.has(canonical(value.path))) records[record.entityId] = record;
    }
  for (const { path, value } of timePaths.values()) {
    const delta = value - (previous ? Number(get(previous.source, path) ?? 0) : 0);
    const bucketDevice =
      previous && get(previous.source, timeAnchor(path)) !== undefined
        ? deviceId
        : 'legacy-baseline';
    const entityId = await fingerprint({ path, deviceId: bucketDevice });
    const old = records[entityId]?.value as TimeValue | undefined;
    if (delta !== 0 || !previous)
      records[entityId] = {
        entityId,
        entityType: 'personal.time',
        value: {
          path,
          deviceId: bucketDevice,
          positive: (old?.positive ?? 0) + Math.max(0, delta),
          negative: (old?.negative ?? 0) + Math.max(0, -delta),
        } satisfies TimeValue,
      };
  }
  return { source, records };
};

export const restorePersonal = (
  heads: Record<string, PlainHead>,
): Record<string, unknown> => {
  const result: Record<string, unknown> = {};
  const time = new Map<string, { path: string[]; value: number }>();
  const documents = Object.values(heads)
    .filter((head) => !head.deleted && head.entityType === 'personal.document')
    .sort(
      (a, b) =>
        (a.value as DocumentValue).path.length - (b.value as DocumentValue).path.length,
    );
  for (const head of documents) {
    const value = head.value as DocumentValue;
    if (!safePath(value.path) || !Object.hasOwn(value, 'data'))
      throw new Error('Malformed personal document');
    set(result, value.path, clean(value.data));
  }
  for (const head of Object.values(heads))
    if (!head.deleted && head.entityType === 'personal.time') {
      const value = head.value as TimeValue;
      if (
        !safePath(value.path) ||
        !Number.isFinite(value.positive) ||
        !Number.isFinite(value.negative) ||
        value.positive < 0 ||
        value.negative < 0
      )
        throw new Error('Malformed private time bucket');
      const key = canonical(value.path);
      time.set(key, {
        path: value.path,
        value: (time.get(key)?.value ?? 0) + value.positive - value.negative,
      });
    }
  for (const bucket of time.values())
    if (get(result, timeAnchor(bucket.path)) !== undefined)
      set(result, bucket.path, Math.max(0, bucket.value));
  const repairIds = (value: unknown): void => {
    if (!object(value)) return;
    if (object(value.entities) && Array.isArray(value.ids)) {
      value.ids = [
        ...new Set([
          ...value.ids.filter(
            (id) => typeof id === 'string' && Object.hasOwn(value.entities as object, id),
          ),
          ...Object.keys(value.entities),
        ]),
      ];
      for (const entity of Object.values(value.entities))
        if (object(entity) && object(entity.timeSpentOnDay))
          entity.timeSpent = Object.values(entity.timeSpentOnDay).reduce<number>(
            (sum, n) => sum + Number(n),
            0,
          );
    }
    for (const child of Object.values(value)) repairIds(child);
  };
  repairIds(result);
  return result;
};

export const baselineFromHeads = (
  heads: Record<string, PlainHead>,
  source: Record<string, unknown>,
): PersonalBaseline => ({
  source: clean(source),
  records: Object.fromEntries(
    Object.values(heads)
      .filter(
        (h) =>
          !h.deleted && ['personal.document', 'personal.time'].includes(h.entityType),
      )
      .map((h) => [
        h.entityId,
        { entityId: h.entityId, entityType: h.entityType, value: h.value },
      ]),
  ),
});

export const personalChanges = (
  before: PersonalBaseline,
  after: PersonalBaseline,
): RecordChange[] => {
  const changes = Object.values(after.records).filter(
    (record) =>
      !before.records[record.entityId] ||
      canonical(record.value) !== canonical(before.records[record.entityId].value),
  );
  for (const record of Object.values(before.records))
    if (!after.records[record.entityId])
      changes.push({
        entityId: record.entityId,
        entityType: record.entityType,
        value: null,
        deleted: true,
      });
  return changes;
};
