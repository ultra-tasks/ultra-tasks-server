import { OperationLike, SchemaMigration } from '../migration.types';

// Settings that are moved from misc to tasks
const MIGRATED_SETTINGS = [
  'isConfirmBeforeTaskDelete',
  'isAutoAddWorkedOnToToday',
  'isAutMarkParentAsDone',
  'isTrayShowCurrentTask',
  'isTurnOffMarkdown',
  'defaultProjectId',
  'taskNotesTpl',
] as const;

/**
 * MultiEntityPayload structure used by the operation log.
 * Operations store their payload in this format.
 */
interface MultiEntityPayload {
  actionPayload: Record<string, unknown>;
  entityChanges?: unknown[];
}

export const MiscToTasksSettingsMigration_v1v2: SchemaMigration = {
  fromVersion: 1,
  toVersion: 2,
  description: 'Move settings from MiscConfig to TasksConfig.',
  migrateState: (state: any) => {
    const misc = state.globalConfig?.misc;
    if (!misc || Object.keys(misc).length === 0) {
      return state;
    }

    const tasks = state.globalConfig?.tasks;
    // Skip migration if tasks already contain the isConfirmBeforeDelete property (tasks is migrated)
    if (tasks?.isConfirmBeforeDelete !== undefined) {
      return state;
    }

    const migratedTasksConfig = {
      ...tasks,
      isConfirmBeforeDelete: misc.isConfirmBeforeTaskDelete ?? false,
      isAutoAddWorkedOnToToday: misc.isAutoAddWorkedOnToToday ?? false,
      isAutoMarkParentAsDone: misc.isAutMarkParentAsDone ?? false,
      isTrayShowCurrent: misc.isTrayShowCurrentTask ?? false,
      isMarkdownFormattingInNotesEnabled: !(misc.isTurnOffMarkdown ?? false),
      defaultProjectId: misc.defaultProjectId ?? null,
      notesTemplate: misc.taskNotesTpl ?? '',
    };

    const updatedMiscConfig = { ...misc };
    delete updatedMiscConfig.isConfirmBeforeTaskDelete;
    delete updatedMiscConfig.isAutoAddWorkedOnToToday;
    delete updatedMiscConfig.isAutMarkParentAsDone;
    delete updatedMiscConfig.isTrayShowCurrentTask;
    delete updatedMiscConfig.isTurnOffMarkdown;
    delete updatedMiscConfig.defaultProjectId;
    delete updatedMiscConfig.taskNotesTpl;

    return {
      ...state,
      globalConfig: {
        ...state.globalConfig,
        misc: updatedMiscConfig,
        tasks: migratedTasksConfig,
      },
    };
  },

  migrateOperation: (op: OperationLike): OperationLike | OperationLike[] | null => {
    // Only handle GLOBAL_CONFIG operations with entityId 'misc'
    if (op.entityType !== 'GLOBAL_CONFIG' || op.entityId !== 'misc') {
      return op;
    }

    const payload = op.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== 'object') {
      return op;
    }

    // Handle MultiEntityPayload structure (used by operation log)
    // The payload format is: { actionPayload: { sectionKey, sectionCfg }, entityChanges }
    let sectionCfg: Record<string, unknown> | null = null;
    let actionPayload: Record<string, unknown> | null = null;

    if (isMultiEntityPayload(payload)) {
      actionPayload = payload.actionPayload;
      sectionCfg = extractSectionCfg(actionPayload);
    } else if ('sectionCfg' in payload) {
      // Direct payload format (for tests or simple cases)
      actionPayload = payload;
      sectionCfg = extractSectionCfg(payload);
    } else {
      // Legacy format: payload is the sectionCfg itself
      sectionCfg = payload;
    }

    if (!sectionCfg || !hasMigratedSettings(sectionCfg)) {
      return op;
    }

    // Create tasks sectionCfg with transformed settings
    const tasksSectionCfg = transformMiscToTasksSectionCfg(sectionCfg);

    // Remove migrated settings from misc sectionCfg
    const updatedMiscSectionCfg = removeMigratedFromMiscSectionCfg(sectionCfg);

    // Generate unique ID for the new tasks operation
    const tasksOpId = `${op.id}_tasks_migrated`;

    const result: OperationLike[] = [];

    // Build misc payload
    const buildPayload = (
      newSectionCfg: Record<string, unknown>,
      newSectionKey: string,
    ): unknown => {
      if (isMultiEntityPayload(payload)) {
        return {
          ...payload,
          actionPayload: {
            ...actionPayload,
            sectionKey: newSectionKey,
            sectionCfg: newSectionCfg,
          },
        };
      } else if (actionPayload && 'sectionCfg' in actionPayload) {
        return {
          ...actionPayload,
          sectionKey: newSectionKey,
          sectionCfg: newSectionCfg,
        };
      } else {
        // Legacy format
        return newSectionCfg;
      }
    };

    // Add misc operation only if there are remaining settings
    if (Object.keys(updatedMiscSectionCfg).length > 0) {
      result.push({
        ...op,
        payload: buildPayload(updatedMiscSectionCfg, 'misc'),
      });
    }

    // Add tasks operation if there are migrated settings
    if (Object.keys(tasksSectionCfg).length > 0) {
      result.push({
        ...op,
        id: tasksOpId,
        entityId: 'tasks',
        payload: buildPayload(tasksSectionCfg, 'tasks'),
      });
    }

    // If no operations remain, return null to drop
    if (result.length === 0) {
      return null;
    }

    // If only one operation, return it directly
    if (result.length === 1) {
      return result[0];
    }

    return result;
  },

  requiresOperationMigration: true,
};

/**
 * Checks if the payload is a MultiEntityPayload structure.
 */
function isMultiEntityPayload(payload: unknown): payload is MultiEntityPayload {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    'actionPayload' in payload &&
    typeof (payload as MultiEntityPayload).actionPayload === 'object'
  );
}

/**
 * Extracts sectionCfg from the action payload.
 * The GlobalConfig action stores settings in { sectionKey, sectionCfg }.
 */
function extractSectionCfg(
  actionPayload: Record<string, unknown>,
): Record<string, unknown> | null {
  if ('sectionCfg' in actionPayload && typeof actionPayload['sectionCfg'] === 'object') {
    return actionPayload['sectionCfg'] as Record<string, unknown>;
  }
  return null;
}

/**
 * Transforms misc sectionCfg to tasks sectionCfg.
 * Maps old field names to new field names and handles value inversions.
 */
function transformMiscToTasksSectionCfg(
  miscCfg: Record<string, unknown>,
): Record<string, unknown> {
  const tasksCfg: Record<string, unknown> = {};

  if ('isConfirmBeforeTaskDelete' in miscCfg) {
    tasksCfg['isConfirmBeforeDelete'] = miscCfg['isConfirmBeforeTaskDelete'];
  }
  if ('isAutoAddWorkedOnToToday' in miscCfg) {
    tasksCfg['isAutoAddWorkedOnToToday'] = miscCfg['isAutoAddWorkedOnToToday'];
  }
  if ('isAutMarkParentAsDone' in miscCfg) {
    tasksCfg['isAutoMarkParentAsDone'] = miscCfg['isAutMarkParentAsDone'];
  }
  if ('isTrayShowCurrentTask' in miscCfg) {
    tasksCfg['isTrayShowCurrent'] = miscCfg['isTrayShowCurrentTask'];
  }
  if ('isTurnOffMarkdown' in miscCfg) {
    // Invert the value: isTurnOffMarkdown -> isMarkdownFormattingInNotesEnabled
    tasksCfg['isMarkdownFormattingInNotesEnabled'] = !miscCfg['isTurnOffMarkdown'];
  }
  if ('defaultProjectId' in miscCfg) {
    tasksCfg['defaultProjectId'] = miscCfg['defaultProjectId'];
  }
  if ('taskNotesTpl' in miscCfg) {
    tasksCfg['notesTemplate'] = miscCfg['taskNotesTpl'];
  }

  return tasksCfg;
}

/**
 * Removes migrated settings from misc sectionCfg.
 */
function removeMigratedFromMiscSectionCfg(
  miscCfg: Record<string, unknown>,
): Record<string, unknown> {
  const updatedCfg = { ...miscCfg };
  for (const key of MIGRATED_SETTINGS) {
    delete updatedCfg[key];
  }
  return updatedCfg;
}

/**
 * Checks if the sectionCfg contains any settings that should be migrated.
 */
function hasMigratedSettings(sectionCfg: Record<string, unknown>): boolean {
  return MIGRATED_SETTINGS.some((key) => key in sectionCfg);
}
