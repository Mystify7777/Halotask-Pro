import type { Subtask, Task } from '../types/task';

/** Mirrors the server (halotasks-server/src/utils/taskValidators.ts): the server is authoritative, this only avoids sending what it would refuse. */
export const MAX_SUBTASKS = 20;
export const SUBTASK_TITLE_MAX_LENGTH = 200;
const SUBTASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Same id source as the sync queue: `crypto.randomUUID` when there is one, otherwise a time + random fallback. */
export const newSubtaskId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const isWellFormed = (value: unknown): value is Subtask => {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === 'string' &&
    SUBTASK_ID_PATTERN.test(item.id) &&
    typeof item.title === 'string' &&
    typeof item.completed === 'boolean'
  );
};

/**
 * The subtasks of a task, as read by every consumer. A task cached before the field existed (or any value that is not
 * an array) reads as `[]`. Items are passed through untouched; nothing here changes stored data.
 */
export const getSubtasks = (task: Pick<Task, 'subtasks'>): Subtask[] => (Array.isArray(task.subtasks) ? task.subtasks : []);

/** Done and total, derived on demand and never stored: the one place that decides what "2/5" means. */
export const subtaskProgress = (task: Pick<Task, 'subtasks'>): { done: number; total: number } => {
  const subtasks = getSubtasks(task);
  return { done: subtasks.filter((subtask) => subtask.completed === true).length, total: subtasks.length };
};

/**
 * The client's SAVE-path normalization (Issue #15 D8): a missing or non-array value is `[]`, titles are trimmed, entries
 * whose title is then blank are dropped, and entries that are not `{ id, title, completed }` objects are dropped.
 * Existing ids are preserved exactly and an id is never generated here (a new entry gets one from `newSubtaskId` when it
 * is created). Only `id`, `title` and `completed` survive. This never repairs a value: it does not rename, re-id or
 * de-duplicate, so use `validateSubtasks` afterwards to refuse what is left over.
 */
export const normalizeSubtasks = (raw: unknown): Subtask[] => {
  if (!Array.isArray(raw)) return [];
  const result: Subtask[] = [];
  for (const item of raw) {
    if (!isWellFormed(item)) continue;
    const title = item.title.trim();
    if (title) result.push({ id: item.id, title, completed: item.completed });
  }
  return result;
};

/** What the server would refuse for a normalized list, as a message for the user; `null` when it is fine to send. */
export const validateSubtasks = (subtasks: Subtask[]): string | null => {
  if (subtasks.length > MAX_SUBTASKS) return `A task can have at most ${MAX_SUBTASKS} subtasks.`;
  if (subtasks.some((subtask) => subtask.title.length > SUBTASK_TITLE_MAX_LENGTH)) {
    return `A subtask title can be at most ${SUBTASK_TITLE_MAX_LENGTH} characters.`;
  }
  if (new Set(subtasks.map((subtask) => subtask.id)).size !== subtasks.length) return 'Subtask ids must be unique.';
  return null;
};

/**
 * The list with ONE subtask's state set, as a new array; `null` when no subtask has that id (so a caller can do
 * nothing). It sets a value rather than flipping, so applying it twice (a re-run updater) gives the same result, and it
 * never touches any other subtask.
 */
export const withSubtaskCompleted = (subtasks: Subtask[], subtaskId: string, completed: boolean): Subtask[] | null => {
  if (!subtasks.some((subtask) => subtask.id === subtaskId)) return null;
  return subtasks.map((subtask) => (subtask.id === subtaskId ? { ...subtask, completed } : subtask));
};

/** Same ids, titles and states in the same order. */
export const sameSubtasks = (a: Subtask[], b: Subtask[]): boolean =>
  a.length === b.length && a.every((item, index) => item.id === b[index].id && item.title === b[index].title && item.completed === b[index].completed);

/** The `  [x] title` / `  [ ] title` lines copied under a task; none for a task without subtasks. */
export const subtaskCopyLines = (task: Pick<Task, 'subtasks'>): string[] =>
  getSubtasks(task).map((subtask) => `  [${subtask.completed ? 'x' : ' '}] ${subtask.title}`);
