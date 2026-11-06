import { canonical } from './encoding';

const equal = (a: unknown, b: unknown): boolean =>
  a === b || canonical(a ?? null) === canonical(b ?? null);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Three-way field merge. A committed overlapping value wins; callers preserve the draft. */
export const mergeRecord = (
  base: unknown,
  local: unknown,
  remote: unknown,
): { value: unknown; conflict: boolean } => {
  if (equal(local, base)) return { value: remote, conflict: false };
  if (equal(remote, base) || equal(local, remote))
    return { value: local, conflict: false };
  if (
    Array.isArray(base) &&
    Array.isArray(local) &&
    Array.isArray(remote) &&
    [...base, ...local, ...remote].every((v) => typeof v === 'string') &&
    [base, local, remote].every((v) => new Set(v).size === v.length)
  ) {
    const retained = new Set(base.filter((v) => local.includes(v) && remote.includes(v)));
    const added = new Set([...local, ...remote].filter((v) => !base.includes(v)));
    const originalOrder = base.filter((v) => retained.has(v));
    const localOrder = local.filter((v) => retained.has(v));
    const remoteOrder = remote.filter((v) => retained.has(v));
    const localMoved = !equal(originalOrder, localOrder);
    const remoteMoved = !equal(originalOrder, remoteOrder);
    const preferred = localMoved && !remoteMoved ? local : remote;
    const other = preferred === local ? remote : local;
    return {
      value: [
        ...preferred.filter((v) => retained.has(v) || added.has(v)),
        ...other.filter((v) => added.has(v) && !preferred.includes(v)),
      ],
      conflict: localMoved && remoteMoved && !equal(localOrder, remoteOrder),
    };
  }
  if (object(base) && object(local) && object(remote)) {
    const value: Record<string, unknown> = {};
    let conflict = false;
    for (const key of new Set([
      ...Object.keys(base),
      ...Object.keys(local),
      ...Object.keys(remote),
    ])) {
      const merged = mergeRecord(base[key], local[key], remote[key]);
      if (merged.value !== undefined) value[key] = merged.value;
      conflict ||= merged.conflict;
    }
    return { value, conflict };
  }
  return { value: remote, conflict: true };
};
