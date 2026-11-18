import type { Priority, Task } from '../types/task';

/**
 * Local validation for task mutations (Issue #57). It checks only what can be decided from local state and the shape of
 * the request itself; the server stays the authority for ownership, limits and business rules, and none of its rules is
 * copied here beyond the ones the client has always applied before sending. Nothing here changes completion semantics:
 * completing or re-opening is derived from the task's latest state by `makeCompletionTransition`, never refused for being
 * "already" in that state.
 */

/** A mutation refused locally. Nothing was written; `message` is safe to show the user. */
export class MutationRejectedError extends Error {
  constructor(
    public readonly code: 'INVALID_FIELDS' | 'TASK_NOT_FOUND' | 'DUPLICATE_LOCAL_ID',
    message: string,
  ) {
    super(message);
    this.name = 'MutationRejectedError';
  }
}

export const TITLE_MAX_LENGTH = 200; // halotasks-server TITLE_MAX_LENGTH
const PRIORITIES: readonly Priority[] = ['low', 'medium', 'high'];
const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

type TaskFields = {
  title?: unknown;
  priority?: unknown;
  description?: unknown;
  tags?: unknown;
  estimatedMinutes?: unknown;
  dueDate?: unknown;
  dueTime?: unknown;
};

/** The first problem with `fields` as a user-facing message, or null. Absent fields are fine: an update names only what changes. */
export const validateTaskFields = (fields: TaskFields, mode: 'create' | 'update'): string | null => {
  if (mode === 'create' || fields.title !== undefined) {
    if (typeof fields.title !== 'string' || !fields.title.trim()) return 'A task needs a title.';
    if (fields.title.trim().length > TITLE_MAX_LENGTH) return `A title can be at most ${TITLE_MAX_LENGTH} characters.`;
  }
  if (mode === 'create' || fields.priority !== undefined) {
    if (!PRIORITIES.includes(fields.priority as Priority)) return 'Priority must be low, medium or high.';
  }
  if (fields.description !== undefined && typeof fields.description !== 'string') return 'The description must be text.';
  if (fields.tags !== undefined && (!Array.isArray(fields.tags) || fields.tags.some((tag) => typeof tag !== 'string'))) {
    return 'Tags must be a list of text.';
  }
  if (fields.estimatedMinutes !== undefined) {
    const minutes = fields.estimatedMinutes;
    if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 0) return 'The estimate must be zero or more minutes.';
  }
  if (fields.dueTime !== undefined && fields.dueTime !== null) {
    if (typeof fields.dueTime !== 'string' || !DUE_TIME_PATTERN.test(fields.dueTime)) return 'The due time must look like 09:30.';
    // A due time only exists next to a due date. In an update that omits `dueDate` the stored date applies, so only an
    // explicit clearing of the date (null or empty) contradicts the time.
    const hasDate = mode === 'create' ? Boolean(fields.dueDate) : fields.dueDate === undefined || Boolean(fields.dueDate);
    if (!hasDate) return 'A due time needs a due date.';
  }
  return null;
};

/** Throws MutationRejectedError when `fields` are not valid. */
export const assertValidTaskFields = (fields: TaskFields, mode: 'create' | 'update'): void => {
  const problem = validateTaskFields(fields, mode);
  if (problem) throw new MutationRejectedError('INVALID_FIELDS', problem);
};

/** The stored task `id`, or MutationRejectedError: a mutation of a task that is not there is refused, not silently dropped. */
export const requireTask = (stored: readonly Task[], id: string): Task => {
  const task = stored.find((item) => item._id === id);
  if (!task) throw new MutationRejectedError('TASK_NOT_FOUND', 'This task no longer exists.');
  return task;
};

/** A new local task id: `local-` plus a UUID. The prefix is what marks a task as not yet known to the server. */
export const newLocalTaskId = (): string =>
  `local-${
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }`;

/** Throws when `id` is already a task id in the stored list. */
export const assertNewLocalId = (stored: readonly Task[], id: string): void => {
  if (stored.some((task) => task._id === id)) {
    throw new MutationRejectedError('DUPLICATE_LOCAL_ID', 'Could not create the task. Please try again.');
  }
};
