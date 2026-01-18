import { SchemaMigration } from '../migration.types';

export const MoveSettingsFromMiscToTasks_v1v2: SchemaMigration = {
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
  requiresOperationMigration: false,
};
