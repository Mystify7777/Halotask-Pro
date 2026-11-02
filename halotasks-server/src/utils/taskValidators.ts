import { isValidCalendarDate } from './calendarDate';
import { isPlainObject } from './requestBody';

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const TAG_MAX_LENGTH = 50;
export const TAGS_MAX_COUNT = 20;
export const ESTIMATED_MINUTES_MAX = 100_000;
/** Subtasks per task (Issue #15). A checklist that supports a task, not a second task manager. */
export const MAX_SUBTASKS = 20;
/** A subtask id is made by the client when the subtask is created and then never changes (offline-safe, stable across syncs). */
export const SUBTASK_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isValidPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function isNonEmptyTitle(title: unknown): title is string {
  return typeof title === 'string' && title.trim().length > 0;
}

/**
 * Parses a due-date input and reports whether it's a genuinely valid date,
 * rather than silently persisting an Invalid Date. Returns `undefined` for
 * "not provided" (distinct from "provided but invalid").
 */
export function parseDueDate(raw: unknown): { ok: true; value: Date | undefined } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: undefined };
  }

  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    return { ok: false };
  }

  return { ok: true, value: date };
}

/** A field a request may leave alone, clear, or set. `null` and `''` mean "clear"; `undefined` means "not sent". */
export const isClearValue = (raw: unknown): boolean => raw === null || raw === '';

/**
 * Machine-readable `code` of the 409 returned when an update sets a dueTime against the stored dueDate and that date
 * was removed before the write (Issue #43). Stable API contract: clients branch on it, never on the message. Specific
 * to this conflict; no other response uses it.
 */
export const TASK_DUE_DATE_REMOVED = 'TASK_DUE_DATE_REMOVED';

/**
 * Due time (Issue #10): a wall-clock time of day, `HH:mm` in 24-hour form. It only means something next to a due
 * date (the deadline is that calendar day plus this time, read in the viewer's local zone), so it is never an
 * instant and never carries a zone.
 */
export const DUE_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDueTime(value: unknown): value is string {
  return typeof value === 'string' && DUE_TIME_PATTERN.test(value);
}

// ISO 8601 date-time WITH an explicit zone designator. A zone-less value would be read in the server's own
// timezone, which is meaningless for a user elsewhere, so it is rejected rather than guessed.
const START_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
const START_TIME_MAX_LENGTH = 40;

/**
 * Start time (Issue #9): an absolute instant. Strict on purpose: `new Date(string)` accepts things that are not
 * dates (2026-02-30 rolls over to March 2, 24:00, a space instead of T) and reads zone-less strings in the server's
 * timezone. Only a real calendar date and a real time, with a zone, are accepted.
 */
export function parseStartTime(raw: unknown): { ok: true; value: Date } | { ok: false } {
  if (typeof raw !== 'string' || raw.length > START_TIME_MAX_LENGTH) return { ok: false };
  const match = START_TIME_PATTERN.exec(raw);
  if (!match || !isValidCalendarDate(match[1])) return { ok: false };
  const instant = new Date(raw);
  return Number.isNaN(instant.getTime()) ? { ok: false } : { ok: true, value: instant };
}

export function isValidEstimatedMinutes(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= ESTIMATED_MINUTES_MAX;
}

export type Subtask = { id: string; title: string; completed: boolean };

/**
 * Subtasks (Issue #15): a small checklist stored on the task and replaced as a whole, like `tags`.
 *
 * STRICT on purpose: malformed input is rejected with a specific message, never repaired, so a client bug cannot turn
 * into silently changed data. The only things done to valid input are trimming a title and dropping keys that are not
 * part of a subtask. `null` clears (an empty list); anything else that is not an array is rejected.
 *
 * Ids must be unique, and uniqueness is checked on the ids exactly as they will be stored. The server never makes up an
 * id: an entry without a valid one is rejected, which keeps a client's ids stable across edits, syncs and the offline
 * local-id remapping.
 */
export function parseSubtasks(raw: unknown): { ok: true; value: Subtask[] } | { ok: false; message: string } {
  if (raw === null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, message: 'subtasks must be an array' };
  if (raw.length > MAX_SUBTASKS) return { ok: false, message: `subtasks cannot have more than ${MAX_SUBTASKS} entries` };

  const value: Subtask[] = [];
  const seen = new Set<string>();

  for (const [index, entry] of raw.entries()) {
    const at = `subtasks[${index}]`;
    if (!isPlainObject(entry)) return { ok: false, message: `${at} must be an object` };

    const { id, title, completed } = entry as Record<string, unknown>;
    if (typeof id !== 'string' || !SUBTASK_ID_PATTERN.test(id)) {
      return { ok: false, message: `${at}.id must be 1-64 characters: letters, digits, underscore or hyphen` };
    }
    if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > TITLE_MAX_LENGTH) {
      return { ok: false, message: `${at}.title must be a non-empty string of at most ${TITLE_MAX_LENGTH} characters` };
    }
    if (typeof completed !== 'boolean') return { ok: false, message: `${at}.completed must be a boolean` };
    if (seen.has(id)) return { ok: false, message: `${at}.id is already used by another subtask` };

    seen.add(id);
    value.push({ id, title: title.trim(), completed });
  }

  return { ok: true, value };
}
