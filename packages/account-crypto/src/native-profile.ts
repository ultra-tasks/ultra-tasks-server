import type { SyncClient } from './sync-client';
import type { SharedTask, TaskOverlay } from './shared-project';

export interface NativeScopeCredential {
  id: string;
  kind: 'personal' | 'project';
  ownerId: string;
  ownerKey: JsonWebKey;
  epoch: number;
  generation: number;
  controlVersion: number;
  sequence: number;
  key: string;
}
export interface NativeReminder {
  scopeId: string;
  taskId: string;
  title: string;
  remindAt: number;
  deadline: boolean;
  shared: boolean;
}
export const nativeScopeCredentials = (client: SyncClient): NativeScopeCredential[] =>
  Object.values(client.state.scopes)
    .filter((scope) => !scope.revoked && scope.info.state === 'active')
    .map((scope) => ({
      id: scope.info.id,
      kind: scope.info.kind,
      ownerId: scope.info.ownerId,
      ownerKey: scope.info.ownerKey,
      epoch: scope.info.epoch,
      generation: scope.info.generation,
      controlVersion: scope.info.controlVersion,
      sequence: scope.info.sequence,
      key: scope.key,
    }));

/** Reads the local projection, including unsent private intent; it never starts a sync. */
export const sharedReminderProjection = (
  client: SyncClient,
  now: number,
): Record<string, NativeReminder> => {
  const desired: Record<string, NativeReminder> = {};
  for (const scope of Object.values(client.state.scopes)) {
    if (scope.revoked || scope.info.kind !== 'personal') continue;
    for (const head of Object.values(client.records(scope.info.id))) {
      if (head.entityType !== 'personal.overlay') continue;
      const overlay = head.value as TaskOverlay;
      const time = overlay.remindAt;
      if (typeof time !== 'number' || !Number.isSafeInteger(time) || time <= now)
        continue;
      const project = client.state.scopes[overlay.scopeId];
      if (!project || project.revoked || project.info.state !== 'active') continue;
      const task = client.record(overlay.scopeId, overlay.taskId)?.value as
        | SharedTask
        | undefined;
      if (!task || task.isDone) continue;
      const id = 'native:' + overlay.scopeId + ':' + overlay.taskId;
      desired[id] = {
        scopeId: overlay.scopeId,
        taskId: id,
        title: task.title,
        remindAt: time,
        deadline: false,
        shared: true,
      };
    }
  }
  return desired;
};
