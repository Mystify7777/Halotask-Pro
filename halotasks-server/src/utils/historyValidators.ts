import {
  addDays,
  getToday,
  isDateInRange,
  isValidCalendarDate,
  isValidUtcOffsetMinutes,
} from './calendarDate';
import {
  ESTIMATED_MINUTES_MAX,
  TITLE_MAX_LENGTH,
  isValidEstimatedMinutes,
} from './taskValidators';

// ── Documented History API contract ─────────────────────────────────────────
//
// Calendar days: see utils/calendarDate.ts. Every request declares the user's UTC offset
// (`utcOffsetMinutes`); dates are the user's local calendar days. There is no UTC fallback.
//
// GET /api/history?days=N&endDate=YYYY-MM-DD&utcOffsetMinutes=M      (endDate and offset REQUIRED)
//   - days: optional integer 1..HISTORY_DAYS_MAX (default HISTORY_DAYS_DEFAULT). Out-of-range,
//     malformed or repeated values are rejected (400), not clamped.
//   - endDate: the user's local "today" (window end, inclusive); must be EXACTLY today at that offset
//     (server clock + offset) — no tolerance, so yesterday and tomorrow are rejected.
//   - utcOffsetMinutes: integer minutes east of UTC, -720..840.
//
// PUT /api/history/today       body: { date, utcOffsetMinutes, ... }   date must be EXACTLY today at that offset.
// PUT /api/history/:date       same body; bounded backfill of the last HISTORY_RETENTION_DAYS days
//                              (the client uses it to deliver a snapshot after its own day has ended).
//   completedTasks: ≤ MAX_COMPLETED_TASKS_PER_DAY entries, unique taskIds, each
//     { taskId, title, estimatedMinutes } (limits below). completedCount must equal
//     completedTasks.length and workDoneMinutes the sum of estimatedMinutes.

export const HISTORY_DAYS_DEFAULT = 7;
export const HISTORY_DAYS_MAX = 90;
export const HISTORY_RETENTION_DAYS = 7;
export const MAX_COMPLETED_TASKS_PER_DAY = 500;
export const MAX_TASK_ID_LENGTH = 64;
/** Mongo ObjectId hex and client-created offline ids (`local-<ts>-<rand>`) both match. */
export const TASK_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const WORK_DONE_MINUTES_MAX = MAX_COMPLETED_TASKS_PER_DAY * ESTIMATED_MINUTES_MAX;

/**
 * `code` is set only for failures that depend on the server's CURRENT clock (the date is not today /
 * out of the allowed window). Those can succeed on a later attempt, whereas every other 400 means the
 * payload itself is invalid. Clients use it to tell "retry shortly" from "this payload can never work".
 */
export const DATE_NOT_TODAY = 'DATE_NOT_TODAY';
export const DATE_OUT_OF_RANGE = 'DATE_OUT_OF_RANGE';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string; code?: string };

export type HistoryQuery = { days: number; endDate: string; utcOffsetMinutes: number };

export type CompletedTaskInput = { taskId: string; title: string; estimatedMinutes: number };

export type HistoryUpsert = {
  date: string;
  completedCount: number;
  workDoneMinutes: number;
  completedTasks: CompletedTaskInput[];
};

const fail = (message: string, code?: string): { ok: false; message: string; code?: string } =>
  code ? { ok: false, message, code } : { ok: false, message };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Query values must be a single string; repeated keys (arrays) and objects are malformed. */
const singleString = (raw: unknown): string | null => (typeof raw === 'string' ? raw : null);

export function parseHistoryQuery(
  query: Record<string, unknown>,
  now: Date = new Date(),
): ValidationResult<HistoryQuery> {
  let days = HISTORY_DAYS_DEFAULT;
  if (query.days !== undefined) {
    const raw = singleString(query.days);
    if (raw === null || !/^[1-9]\d{0,2}$/.test(raw)) {
      return fail(`days must be a single integer between 1 and ${HISTORY_DAYS_MAX}.`);
    }
    days = Number(raw);
    if (days > HISTORY_DAYS_MAX) {
      return fail(`days must be a single integer between 1 and ${HISTORY_DAYS_MAX}.`);
    }
  }

  const rawOffset = singleString(query.utcOffsetMinutes);
  if (rawOffset === null || !/^-?\d{1,4}$/.test(rawOffset)) {
    return fail('utcOffsetMinutes is required: a single integer number of minutes east of UTC.');
  }
  const utcOffsetMinutes = Number(rawOffset);
  if (!isValidUtcOffsetMinutes(utcOffsetMinutes)) {
    return fail('utcOffsetMinutes must be between -720 and 840.');
  }

  const rawEnd = singleString(query.endDate);
  if (rawEnd === null || !isValidCalendarDate(rawEnd)) {
    return fail('endDate is required: a single valid date in YYYY-MM-DD format (the local date of the user).');
  }
  if (rawEnd !== getToday(utcOffsetMinutes, now)) {
    return fail('endDate must be today\'s date at the given utcOffsetMinutes.', DATE_NOT_TODAY);
  }

  return { ok: true, value: { days, endDate: rawEnd, utcOffsetMinutes } };
}

/** The window of dates a GET returns, oldest → newest, ending at the client-declared local today. */
export function buildDateWindow(days: number, endDate: string): string[] {
  const dates: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    dates.push(addDays(endDate, -i));
  }
  return dates;
}

const parseCompletedTask = (raw: unknown, index: number): ValidationResult<CompletedTaskInput> => {
  if (!isPlainObject(raw)) {
    return fail(`completedTasks[${index}] must be an object.`);
  }

  const { taskId, title, estimatedMinutes } = raw;

  if (
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    taskId.length > MAX_TASK_ID_LENGTH ||
    !TASK_ID_PATTERN.test(taskId)
  ) {
    return fail(`completedTasks[${index}].taskId must be 1-${MAX_TASK_ID_LENGTH} characters of letters, digits, "-" or "_".`);
  }

  if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > TITLE_MAX_LENGTH) {
    return fail(`completedTasks[${index}].title must be a non-empty string of at most ${TITLE_MAX_LENGTH} characters.`);
  }

  if (typeof estimatedMinutes !== 'number' || !isValidEstimatedMinutes(estimatedMinutes)) {
    return fail(`completedTasks[${index}].estimatedMinutes must be a finite number between 0 and ${ESTIMATED_MINUTES_MAX}.`);
  }

  return { ok: true, value: { taskId, title: title.trim(), estimatedMinutes } };
};

export function parseHistoryUpsert(
  body: unknown,
  options: { mode: 'today' | 'backfill'; pathDate?: string; now?: Date },
): ValidationResult<HistoryUpsert> {
  const now = options.now ?? new Date();

  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object.');
  }

  // ── declared offset (required: the server has no other way to know the user's day) ──
  if (!isValidUtcOffsetMinutes(body.utcOffsetMinutes)) {
    return fail('utcOffsetMinutes is required: an integer number of minutes east of UTC between -720 and 840.');
  }
  const today = getToday(body.utcOffsetMinutes, now);

  // ── date ──────────────────────────────────────────────────────────────────
  let date: unknown = body.date;
  if (options.mode === 'backfill') {
    if (!isValidCalendarDate(options.pathDate)) {
      return fail('Invalid date in path (expected YYYY-MM-DD).');
    }
    if (date !== undefined && date !== options.pathDate) {
      return fail('Body date must match the date in the path.');
    }
    date = options.pathDate;
  }

  if (!isValidCalendarDate(date)) {
    return fail('Invalid or missing date (expected a real calendar date in YYYY-MM-DD format).');
  }

  if (options.mode === 'today') {
    if (date !== today) {
      return fail(
        'date must be today\'s date at the given utcOffsetMinutes; use PUT /api/history/:date to backfill the last 7 days.',
        DATE_NOT_TODAY,
      );
    }
  } else {
    const oldest = addDays(today, -(HISTORY_RETENTION_DAYS - 1));
    if (!isDateInRange(date, oldest, today)) {
      return fail(
        `date must be within the last ${HISTORY_RETENTION_DAYS} days and not in the future.`,
        DATE_OUT_OF_RANGE,
      );
    }
  }

  // ── completedTasks ────────────────────────────────────────────────────────
  if (!Array.isArray(body.completedTasks)) {
    return fail('completedTasks must be an array.');
  }
  if (body.completedTasks.length > MAX_COMPLETED_TASKS_PER_DAY) {
    return fail(`completedTasks may contain at most ${MAX_COMPLETED_TASKS_PER_DAY} entries.`);
  }

  const completedTasks: CompletedTaskInput[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < body.completedTasks.length; i += 1) {
    const parsed = parseCompletedTask(body.completedTasks[i], i);
    if (!parsed.ok) return parsed;
    if (seen.has(parsed.value.taskId)) {
      return fail(`completedTasks contains a duplicate taskId (index ${i}).`);
    }
    seen.add(parsed.value.taskId);
    completedTasks.push(parsed.value);
  }

  // ── numbers (strict: no Number(x) || 0 coercion) ─────────────────────────
  const { completedCount, workDoneMinutes } = body;

  if (
    typeof completedCount !== 'number' ||
    !Number.isInteger(completedCount) ||
    completedCount < 0 ||
    completedCount > MAX_COMPLETED_TASKS_PER_DAY
  ) {
    return fail(`completedCount must be an integer between 0 and ${MAX_COMPLETED_TASKS_PER_DAY}.`);
  }

  if (
    typeof workDoneMinutes !== 'number' ||
    !Number.isFinite(workDoneMinutes) ||
    workDoneMinutes < 0 ||
    workDoneMinutes > WORK_DONE_MINUTES_MAX
  ) {
    return fail(`workDoneMinutes must be a finite number between 0 and ${WORK_DONE_MINUTES_MAX}.`);
  }

  if (completedCount !== completedTasks.length) {
    return fail('completedCount must equal the number of completedTasks.');
  }

  const expectedMinutes = completedTasks.reduce((sum, t) => sum + t.estimatedMinutes, 0);
  if (Math.abs(workDoneMinutes - expectedMinutes) > 1e-6) {
    return fail('workDoneMinutes must equal the sum of completedTasks estimatedMinutes.');
  }

  return { ok: true, value: { date, completedCount, workDoneMinutes, completedTasks } };
}
