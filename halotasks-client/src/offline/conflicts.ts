import type { Task } from '../types/task';

/**
 * Task conflicts, client side (Issue #62B). The server contract is Issue #62A (halotasks-server src/utils/taskConflict.ts): an
 * update mutation may carry `base`, the value the user SAW the server hold for each field they changed, and the server answers
 * `conflict` instead of overwriting when that field holds something else by now.
 *
 * INVARIANT (D11, base immutability): `base[field]` is the stored, server-derived value at the start of the user's FIRST unsent edit
 * of that field. Later local edits of the field change only the requested value (the payload), never the base, until that
 * field's mutation is settled or resolved (server A, user types B, then C, then D: base A, requested D). The queue enforces it
 * (`applyActionToQueue` keeps the earlier entry's base for every field it already holds). The single-task fallback requests
 * carry no base: they stay last-write-wins.
 *
 * Only fields the user actually CHANGED get a base. The edit form sends every field on every save, and a field it merely repeats
 * must not turn another device's change into a conflict the user never caused (it stays last-write-wins, as before).
 */

export const CHECKED_FIELDS = ['title', 'description', 'priority', 'tags', 'subtasks', 'dueDate', 'dueTime', 'startTime', 'estimatedMinutes', 'reminderSent'] as const;
export type CheckedField = (typeof CHECKED_FIELDS)[number];

/** Field -> the value the server was last known to hold (JSON-safe; `null` = the field was absent). */
export type BaseValues = Partial<Record<CheckedField, unknown>>;

/** One conflicted field as the server reports it (dates as ISO strings, absent as null). */
export type FieldConflict = { field: CheckedField; base: unknown; requested: unknown; current: unknown };

const DATE_FIELDS: readonly CheckedField[] = ['dueDate', 'startTime'];

/** The value a task holds for a field, in the same comparable form the server uses (absent optional field = null, defaults filled in). */
export const taskValue = (task: Partial<Task>, field: CheckedField): unknown => {
  const raw = (task as Record<string, unknown>)[field];
  switch (field) {
    case 'tags':
      return Array.isArray(raw) ? [...(raw as string[])] : [];
    case 'subtasks':
      return Array.isArray(raw) ? (raw as Array<{ id: string; title: string; completed: boolean }>).map(({ id, title, completed }) => ({ id, title, completed })) : [];
    case 'description':
      return raw ?? '';
    case 'priority':
      return raw ?? 'medium';
    case 'estimatedMinutes':
      return raw ?? 0;
    case 'reminderSent':
      return raw ?? false;
    default:
      return raw ?? null;
  }
};

/** What an update payload asks for (`null`/`''` clear an optional field; a null list means []). */
const requestedValue = (payload: Record<string, unknown>, field: CheckedField): unknown => {
  const raw = payload[field];
  if (field === 'dueDate' || field === 'dueTime' || field === 'startTime') return raw === null || raw === '' ? null : raw;
  if (field === 'subtasks' && raw === null) return [];
  if (field === 'title' || field === 'description') return typeof raw === 'string' ? raw.trim() : raw;
  return raw;
};

const sameField = (field: CheckedField, a: unknown, b: unknown): boolean => {
  if (DATE_FIELDS.includes(field)) {
    if (a === null || b === null) return a === b;
    return Date.parse(String(a)) === Date.parse(String(b));
  }
  return JSON.stringify(a) === JSON.stringify(b);
};

/**
 * The base for an update of `task` carrying `payload`: the stored value of every checked field the payload CHANGES. `task` is the
 * task as stored when the user acted, i.e. the last server-adopted copy plus any earlier unsent edit; for a field with an earlier
 * unsent edit the queue keeps that entry's base instead (see `mergeBase`).
 */
export const captureBase = (task: Partial<Task> | undefined, payload: Record<string, unknown> | undefined): BaseValues => {
  const base: BaseValues = {};
  if (!task || !payload) return base;
  for (const field of CHECKED_FIELDS) {
    if (payload[field] === undefined) continue;
    const stored = taskValue(task, field);
    if (!sameField(field, stored, requestedValue(payload, field))) base[field] = stored;
  }
  return base;
};

/**
 * The base after an edit is merged into a queued update: the EARLIER base wins for every field it holds (D11); fields it does not
 * hold take the new edit's base. `rebase` (a resolution: Keep mine) replaces instead: the user has now seen the server's value.
 * An entry that has no base at all (queued before this existed) stays without one: its stored values may already be local edits, so
 * nothing trustworthy can be added, and it keeps today's last-write-wins behaviour.
 */
export const mergeBase = (earlier: BaseValues | undefined, incoming: BaseValues | undefined, rebase = false): BaseValues | undefined => {
  if (rebase) return { ...(earlier ?? {}), ...(incoming ?? {}) };
  if (earlier === undefined) return undefined;
  return { ...(incoming ?? {}), ...earlier };
};

/** The stored value, in the server task, of each checked field a sent payload carried: what the server now holds for them. */
export const canonicalBase = (serverTask: Partial<Task>, sent: Record<string, unknown> | undefined): BaseValues => {
  const base: BaseValues = {};
  if (!sent) return base;
  for (const field of CHECKED_FIELDS) if (sent[field] !== undefined) base[field] = taskValue(serverTask, field);
  return base;
};

/** A base only for the fields of `delta`: what a residual update (the edits made while a request was out) is judged against. */
export const baseForDelta = (delta: Record<string, unknown>, ...sources: Array<BaseValues | undefined>): BaseValues | undefined => {
  if (sources.every((source) => source === undefined)) return undefined;
  const base: BaseValues = {};
  for (const field of CHECKED_FIELDS) {
    if (!(field in delta)) continue;
    for (const source of sources) {
      if (source && field in source) {
        base[field] = source[field];
        break;
      }
    }
  }
  return base;
};

/** The server answered `conflict`: nothing of the mutation was written. Carries what the notice needs. */
export class TaskConflictError extends Error {
  readonly conflicts: FieldConflict[];
  readonly task: Task | null;
  constructor(conflicts: FieldConflict[], task: Task | null) {
    super('The task changed elsewhere; the edit was not applied.');
    this.name = 'TaskConflictError';
    this.conflicts = conflicts;
    this.task = task;
  }
}

/**
 * An edit the server did not apply because another device changed a field first. Session memory only (D7): it is shown until the
 * person resolves it and is never persisted. `mine` is everything the discarded edit asked for, so "Keep mine" can send it again.
 */
export type ConflictedMutation = {
  taskId: string;
  title: string | null;
  fields: FieldConflict[];
  /** The discarded payload, as the user made it. */
  mine: Record<string, unknown>;
  /** The base the discarded edit carried. */
  base: BaseValues;
};

/** The base and payload of a fresh edit that re-applies a discarded one on top of what the server holds now (D8: Keep mine). */
export const keepMineEdit = (conflict: ConflictedMutation): { payload: Record<string, unknown>; base: BaseValues } => {
  const base: BaseValues = {};
  for (const field of CHECKED_FIELDS) if (field in conflict.mine && field in conflict.base) base[field] = conflict.base[field];
  // the user has now seen what the server holds: that is the value the new edit is based on
  for (const item of conflict.fields) base[item.field] = item.current;
  return { payload: { ...conflict.mine }, base };
};

/** The local task with an update payload applied (the local copy of an edit). Clearing an optional field removes it. */
export const applyUpdatePayload = (task: Task, payload: Record<string, unknown>): Task => {
  const next: Record<string, unknown> = { ...task };
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined) continue;
    if (value === null && (key === 'dueDate' || key === 'dueTime' || key === 'startTime')) delete next[key];
    else next[key] = value;
  }
  return next as Task;
};

const LABEL: Record<CheckedField, string> = {
  title: 'title',
  description: 'description',
  priority: 'priority',
  tags: 'tags',
  subtasks: 'subtasks',
  dueDate: 'due date',
  dueTime: 'due time',
  startTime: 'start time',
  estimatedMinutes: 'estimate',
  reminderSent: 'reminder',
};

const show = (field: CheckedField, value: unknown): string => {
  if (value === null || value === undefined || value === '') return 'none';
  if (Array.isArray(value)) return `${value.length} ${field === 'tags' ? (value.length === 1 ? 'tag' : 'tags') : value.length === 1 ? 'subtask' : 'subtasks'}`;
  if (DATE_FIELDS.includes(field) && typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value.slice(0, 10);
  if (field === 'estimatedMinutes') return `${String(value)} min`;
  const text = String(value);
  return text.length > 30 ? `“${text.slice(0, 29)}…”` : `“${text}”`;
};

/** The sentence a person reads for one conflict: what was not saved, what is different, and the two choices. Pure. */
export const describeConflict = (conflict: ConflictedMutation, fallbackTitle: string | null = null): string => {
  const title = conflict.title ?? fallbackTitle;
  const subject = title ? `“${title}”` : 'A task';
  const parts = conflict.fields.slice(0, 3).map((item) => `${LABEL[item.field]}: yours ${show(item.field, item.requested)}, now ${show(item.field, item.current)}`);
  const more = conflict.fields.length > 3 ? ` and ${conflict.fields.length - 3} more` : '';
  return `${subject} was changed on another device, so your edit was not saved (${parts.join('; ')}${more}).`;
};
