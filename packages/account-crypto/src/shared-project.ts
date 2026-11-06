export interface SharedTask {
  title: string;
  isDone?: boolean;
  description?: string;
  deadlineDay?: string | null;
  deadlineWithTime?: number | null;
  assigneeId?: string | null;
  parentId?: string | null;
  sectionId?: string | null;
  rank?: number;
}
export interface TaskOverlay {
  scopeId: string;
  taskId: string;
  label: string;
  dueDay?: string | null;
  dueWithTime?: number | null;
  remindAt?: number | null;
  priority?: number | string | null;
  tagIds?: string[];
  timeSpentOnDay?: Record<string, number>;
  timeEstimate?: number;
  personalNotes?: string;
  timeBuckets?: Record<string, number>;
}
const fields = [
  'title',
  'isDone',
  'description',
  'deadlineDay',
  'deadlineWithTime',
  'assigneeId',
  'parentId',
  'sectionId',
  'rank',
];
/** A shared document never accepts a composed personal task or provider credentials. */
export const validateSharedRecord = (type: string, value: unknown): void => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed shared document');
  const doc = value as Record<string, unknown>;
  const allowed =
    type === 'shared.task'
      ? fields
      : type === 'shared.project'
        ? ['title', 'archived']
        : type === 'shared.section'
          ? ['title', 'rank']
          : [];
  if (
    !allowed.length ||
    Object.keys(doc).some((key) => !allowed.includes(key)) ||
    typeof doc.title !== 'string' ||
    doc.title.length > 8192
  )
    throw new Error('Invalid shared fields');
  for (const key of ['description', 'deadlineDay', 'assigneeId', 'parentId', 'sectionId'])
    if (doc[key] != null && typeof doc[key] !== 'string')
      throw new Error('Invalid shared text');
  for (const key of ['deadlineWithTime', 'rank'])
    if (doc[key] != null && (typeof doc[key] !== 'number' || !Number.isFinite(doc[key])))
      throw new Error('Invalid shared number');
  for (const key of ['isDone', 'archived'])
    if (doc[key] != null && typeof doc[key] !== 'boolean')
      throw new Error('Invalid shared state');
};
export const sharedTaskFromPersonal = (
  task: Record<string, unknown>,
  includeDescription = false,
): SharedTask => ({
  title: String(task.title ?? ''),
  isDone: task.isDone === true,
  ...(includeDescription && typeof task.notes === 'string'
    ? { description: task.notes }
    : {}),
  ...(typeof task.deadlineDay === 'string' ? { deadlineDay: task.deadlineDay } : {}),
  ...(typeof task.deadlineWithTime === 'number'
    ? { deadlineWithTime: task.deadlineWithTime }
    : {}),
});

export const validateSharedHierarchy = (tasks: Record<string, SharedTask>): void => {
  const completed = new Set<string>();
  for (const id of Object.keys(tasks)) {
    const path = new Set<string>();
    let current: string | null | undefined = id;
    while (current && tasks[current] && !completed.has(current)) {
      if (path.has(current)) throw new Error('Shared task hierarchy contains a cycle');
      path.add(current);
      current = tasks[current].parentId;
    }
    for (const visited of path) completed.add(visited);
  }
};
