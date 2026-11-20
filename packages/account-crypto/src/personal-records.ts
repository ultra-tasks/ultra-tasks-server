import { canonical, fingerprint } from './encoding';
import type { RecordChange } from './sync-client';
import type { Intent, PlainHead } from './sync-types';

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
  foldedTime?: { path: string[]; elapsed: number };
}
type TaskLocations = Map<string, { path: string[]; entityId: string } | null>;
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
const taskIdAt = (path: string[]): string | undefined => {
  if (path.length === 3 && path[0] === 'task' && path[1] === 'entities') return path[2];
  if (
    path.length === 4 &&
    (path[0] === 'archiveYoung' || path[0] === 'archiveOld') &&
    path[1] === 'task' &&
    path[2] === 'entities'
  )
    return path[3];
  return undefined;
};
const taskLocations = (
  records: Iterable<Pick<RecordChange, 'entityId' | 'entityType' | 'value' | 'deleted'>>,
): TaskLocations => {
  const result: TaskLocations = new Map();
  for (const record of records) {
    if (record.deleted || record.entityType !== 'personal.document') continue;
    const path = (record.value as DocumentValue | null)?.path;
    if (!safePath(path)) continue;
    const id = taskIdAt(path);
    if (id) result.set(id, result.has(id) ? null : { path, entityId: record.entityId });
  }
  return result;
};
const relocatedTimePath = (path: string[], locations: TaskLocations): string[] => {
  if (path.at(-2) !== 'timeSpentOnDay') return path;
  const anchor = timeAnchor(path);
  const id = taskIdAt(anchor);
  const location = id && locations.get(id);
  return location && canonical(location.path) !== canonical(anchor)
    ? [...location.path, ...path.slice(-2)]
    : path;
};
const timeValue = (value: unknown): TimeValue | undefined => {
  if (
    !object(value) ||
    !safePath(value.path) ||
    typeof value.deviceId !== 'string' ||
    typeof value.positive !== 'number' ||
    typeof value.negative !== 'number' ||
    !Number.isFinite(value.positive) ||
    !Number.isFinite(value.negative) ||
    value.positive < 0 ||
    value.negative < 0
  )
    return undefined;
  const folded = value.foldedTime;
  if (
    folded !== undefined &&
    (!object(folded) ||
      !safePath(folded.path) ||
      typeof folded.elapsed !== 'number' ||
      !Number.isFinite(folded.elapsed))
  )
    return undefined;
  return value as unknown as TimeValue;
};
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
  const previousRecords = Object.values(previous?.records ?? {});
  const locations = taskLocations(Object.values(records));
  const previousLocations = taskLocations(previousRecords);
  const buckets = new Map<string, RecordChange>();
  for (const record of previousRecords) {
    if (record.entityType !== 'personal.time') continue;
    const value = record.value as TimeValue;
    const path = relocatedTimePath(value.path, locations);
    const key = canonical(path);
    if (!timePaths.has(key) && get(source, timeAnchor(path)) !== undefined)
      timePaths.set(key, { path, value: 0 });
    if (timePaths.has(key)) {
      // Archiving moves the bucket with the task, keeping its revision and contributions.
      const carried =
        path === value.path ? record : { ...record, value: { ...value, path } };
      records[record.entityId] = carried;
      buckets.set(canonical({ path, deviceId: value.deviceId }), carried);
    }
  }
  for (const { path, value } of timePaths.values()) {
    const previousPath = relocatedTimePath(path, previousLocations);
    const delta =
      value - (previous ? Number(get(previous.source, previousPath) ?? 0) : 0);
    if (delta === 0 && previous) continue;
    const bucketDevice =
      previous && get(previous.source, timeAnchor(previousPath)) !== undefined
        ? deviceId
        : 'legacy-baseline';
    const identity = { path, deviceId: bucketDevice };
    const bucket = buckets.get(canonical(identity));
    const entityId = bucket?.entityId ?? (await fingerprint(identity));
    // A split archive can temporarily expose both locations. The original ID can
    // already belong to the carried bucket at the destination.
    const existing = timeValue(records[entityId]?.value);
    const old = existing?.deviceId === bucketDevice ? existing : undefined;
    records[entityId] = {
      entityId,
      entityType: 'personal.time',
      value: {
        ...old,
        path: old?.path ?? path,
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
  const locations = taskLocations(documents);
  for (const head of Object.values(heads))
    if (!head.deleted && head.entityType === 'personal.time') {
      const value = timeValue(head.value);
      if (!value) throw new Error('Malformed private time bucket');
      const path = relocatedTimePath(value.path, locations);
      const key = canonical(path);
      time.set(key, {
        path,
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

/** Include buckets that arrived after a local move was prepared, in the move's transaction. */
export const preparePersonalTimeRebase = (
  remote: Record<string, PlainHead>,
  intents: Intent[],
): TaskLocations => {
  const queued = new Set<string>();
  const projected: Record<
    string,
    Pick<PlainHead, 'entityId' | 'entityType' | 'value' | 'deleted'>
  > = {
    ...remote,
  };
  const removals = new Map<string, Intent>();
  for (const intent of intents)
    for (const change of intent.changes) {
      queued.add(change.entityId);
      if (change.entityType === 'personal.document') {
        projected[change.entityId] = change;
        if (change.deleted) removals.set(change.entityId, intent);
      }
    }
  const locations = taskLocations(Object.values(projected));
  if (!removals.size) return locations;

  const remoteLocations = taskLocations(Object.values(remote));
  const overflow: Intent['changes'] = [];
  for (const head of Object.values(remote)) {
    if (head.deleted || head.entityType !== 'personal.time' || queued.has(head.entityId))
      continue;
    const value = timeValue(head.value);
    if (!value) continue;
    const anchor = timeAnchor(value.path);
    const taskId = taskIdAt(anchor);
    const source = taskId && remoteLocations.get(taskId);
    if (!source || canonical(source.path) !== canonical(anchor)) continue;
    const intent = removals.get(source.entityId);
    if (!intent) continue;
    const path = relocatedTimePath(value.path, locations);
    if (path === value.path) continue;
    const change = {
      entityId: head.entityId,
      entityType: head.entityType,
      deleted: false,
      base: head,
      value: { ...value, path },
    };
    (intent.changes.length < 100 ? intent.changes : overflow).push(change);
  }
  for (let offset = 0; offset < overflow.length; offset += 100)
    intents.push({
      id: crypto.randomUUID(),
      changes: overflow.slice(offset, offset + 100),
    });
  return locations;
};

export const hasDifferentTaskTimeLocation = (
  change: Intent['changes'][number],
  locations: TaskLocations,
): boolean => {
  if (change.deleted || change.entityType !== 'personal.time') return false;
  const value = timeValue(change.value);
  return !!value && relocatedTimePath(value.path, locations) !== value.path;
};

/** A timer may point at the task's former location while this device is offline. */
export const rebasePersonalTimeChange = (
  change: Intent['changes'][number],
  target: PlainHead | undefined,
  remote: PlainHead | undefined,
  locations: TaskLocations,
): void => {
  if (change.deleted || change.entityType !== 'personal.time') return;
  const value = timeValue(change.value);
  if (!value) return;
  const path = relocatedTimePath(value.path, locations);
  const base = timeValue(change.base?.value);
  if (remote?.deleted && base && relocatedTimePath(base.path, locations) !== base.path) {
    // Older clients fold acknowledged time into the archived baseline and delete old IDs.
    // Carry just this device's unacknowledged contribution across such a move.
    const retained = timeValue(target?.value);
    change.base = target ?? null;
    change.restore = target?.deleted || undefined;
    change.value = {
      ...value,
      path,
      positive: (retained?.positive ?? 0) + Math.max(0, value.positive - base.positive),
      negative: (retained?.negative ?? 0) + Math.max(0, value.negative - base.negative),
      // The app can recapture its still-active workspace after a restart. Persist
      // the part already carried by the archived total alongside this counter.
      foldedTime: retained?.foldedTime ?? {
        path: base.path,
        elapsed: base.positive - base.negative,
      },
    } satisfies TimeValue;
  } else if (path !== value.path) {
    change.value = { ...value, path };
  }
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
