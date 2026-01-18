import { MIGRATIONS } from './index';

MIGRATIONS.push({
  fromVersion: 1,
  toVersion: 2,
  description: 'Move settings from MiscConfig to TasksConfig.',
  migrateState: (state: any) => {
    if (!state.misc || Object.keys(state.misc).length === 0) {
      return state;
    }

    // Skip migration if tasks already contain the isConfirmBeforeDelete property (tasks is migrated)
    if (state.tasks?.isConfirmBeforeTaskDelete !== undefined) {
      return state;
    }

    const migratedTasksConfig = {
      ...state.tasks,
      isConfirmBeforeDelete: state.misc.isConfirmBeforeTaskDelete ?? false,
      isAutoAddWorkedOnToToday: state.misc.isAutoAddWorkedOnToToday ?? false,
      isAutoMarkParentAsDone: state.misc.isAutMarkParentAsDone ?? false,
      isTrayShowCurrent: state.misc.isTrayShowCurrentTask ?? false,
      isMarkdownFormattingInNotesEnabled: !(state.misc.isTurnOffMarkdown ?? false),
      defaultProjectId: state.misc.defaultProjectId ?? null,
      notesTemplate: state.misc.taskNotesTpl ?? '',
    };

    const updatedMiscConfig = { ...state.misc };
    delete updatedMiscConfig.isConfirmBeforeTaskDelete;
    delete updatedMiscConfig.isAutoAddWorkedOnToToday;
    delete updatedMiscConfig.isAutMarkParentAsDone;
    delete updatedMiscConfig.isTrayShowCurrentTask;
    delete updatedMiscConfig.isTurnOffMarkdown;
    delete updatedMiscConfig.defaultProjectId;
    delete updatedMiscConfig.taskNotesTpl;

    return {
      ...state,
      tasks: migratedTasksConfig,
      misc: updatedMiscConfig,
    };
  },
  requiresOperationMigration: false,
});
