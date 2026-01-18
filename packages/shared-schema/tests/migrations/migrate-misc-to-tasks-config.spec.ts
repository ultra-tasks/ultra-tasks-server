import { describe, it, expect } from 'vitest';
import { MIGRATIONS } from '../../src/migrations';

describe('Migrate MiscConfig to TasksConfig', () => {
  const migration = MIGRATIONS.find((m) => m.fromVersion === 1 && m.toVersion === 2);

  if (!migration) {
    throw new Error('Migration for version 1 to 2 not found');
  }

  it('should migrate settings from misc to tasks', () => {
    const initialState = {
      misc: {
        isConfirmBeforeTaskDelete: true,
        isAutoAddWorkedOnToToday: true,
        isAutMarkParentAsDone: false,
        isTrayShowCurrentTask: true,
        defaultProjectId: 'project_1',
        taskNotesTpl: 'Template',
      },
      tasks: {},
    };

    const migratedState = migration.migrateState(initialState) as {
      misc: Record<string, unknown>;
      tasks: Record<string, unknown>;
    };

    expect(migratedState.tasks).toEqual({
      isConfirmBeforeTaskDelete: true,
      isAutoAddWorkedOnToToday: true,
      isAutoMarkParentAsDone: false,
      isTrayShowCurrentTask: true,
      defaultProjectId: 'project_1',
      notesTemplate: 'Template',
    });

    expect(migratedState.misc).toEqual({});
  });

  it('should not modify state if misc is empty', () => {
    const initialState = {
      misc: {},
      tasks: {},
    };

    const migratedState = migration.migrateState(initialState) as {
      misc: Record<string, unknown>;
      tasks: Record<string, unknown>;
    };

    expect(migratedState).toEqual(initialState);
  });

  it('should not modify state if tasks already migrated', () => {
    const initialState = {
      misc: {
        isConfirmBeforeTaskDelete: true,
      },
      tasks: {
        isConfirmBeforeTaskDelete: true,
      },
    };

    const migratedState = migration.migrateState(initialState) as {
      misc: Record<string, unknown>;
      tasks: Record<string, unknown>;
    };

    expect(migratedState).toEqual(initialState);
  });
});
