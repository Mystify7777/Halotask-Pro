import { isValidCalendarDate, isValidUtcOffsetMinutes, localDateAt } from './calendarDate';
import { MAX_TASK_ID_LENGTH, TASK_ID_PATTERN } from './historyValidators';
import { isPlainObject } from './requestBody';
import { ESTIMATED_MINUTES_MAX, TITLE_MAX_LENGTH, isValidEstimatedMinutes, parseStartTime } from './taskValidators';

// ── Completion events (Issue #47) ───────────────────────────────────────────────────────────────────────────────
//
// A CompletionRecord is created ONLY from a validated completion transition, never from a task snapshot. Task state
// answers "is this task complete right now?"; the records answer "which completion transitions happened?".
//
// An event arrives in one of two ways, and both go through the same parsing and the same service
// (utils/completionRecords.ts), so one `completionId` can only ever resolve to one record:
//   - as `completionEvent` on a task write (PUT /api/tasks/:id, POST /api/tasks). The kind follows `completed`:
//       completed: true  -> { completionId, completedAt, utcOffsetMinutes, localDate? }          a completion
//       completed: false -> { completionId?, revokedAt }                                           a revocation
//   - as POST /api/completion-events, for an event whose task cannot be written (deleted, or never synced):
//       { type: 'complete', completionId, taskId, title, estimatedMinutes, completedAt, utcOffsetMinutes, localDate? }
//       { type: 'revoke', completionId, taskId? , revokedAt }
//
// Time: `completedAt` is the instant the user acted, observed by the client. The server stores its own `receivedAt`
// separately and NEVER substitutes it for a client time. `localDate` is DERIVED from completedAt + utcOffsetMinutes
// (the calendar-date convention of Issue #31); a client-sent `localDate` is only checked against it.

/** Client-generated; same shape as a subtask id. */
export const COMPLETION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** An event older than this is outside the history window and is not recorded. */
export const MAX_EVENT_AGE_MS = 90 * 24 * 60 * 60 * 1000;
/** Tolerated clock difference between a device and the server for an event "in the future". */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

/**
 * Machine-readable codes. Stable API contract: clients branch on these, never on the message.
 *  - COMPLETION_TIME_OUT_OF_WINDOW: the event time is more than 90 days old or more than 5 minutes ahead of the server.
 *  - COMPLETION_ID_REUSED: the completionId already belongs to a different event (other task or other time).
 *  - COMPLETION_TASK_MISMATCH: the revoked completion belongs to another task.
 *  - COMPLETION_NOT_FOUND: nothing with that completionId exists for this account.
 */
export const COMPLETION_TIME_OUT_OF_WINDOW = 'COMPLETION_TIME_OUT_OF_WINDOW';
export const COMPLETION_ID_REUSED = 'COMPLETION_ID_REUSED';
export const COMPLETION_TASK_MISMATCH = 'COMPLETION_TASK_MISMATCH';
/**
 * COMPLETION_TASK_EXISTS (409): the standalone endpoint is for events whose task cannot be written. The task still exists here,
 * so the transition must go through the task write, where it is arbitrated; the client retries it there.
 */
export const COMPLETION_TASK_EXISTS = 'COMPLETION_TASK_EXISTS';
export const COMPLETION_NOT_FOUND = 'COMPLETION_NOT_FOUND';

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type CompleteEvent = {
  kind: 'complete';
  completionId: string;
  completedAt: Date;
  utcOffsetMinutes: number;
  /** Derived from completedAt + utcOffsetMinutes. */
  localDate: string;
};

export type RevokeEvent = {
  kind: 'revoke';
  /** Absent means "the completion this task currently has" (a device that never saw the id, e.g. another device). */
  completionId?: string;
  revokedAt: Date;
};

export type TaskCompletionEvent = CompleteEvent | RevokeEvent;

export type StandaloneCompleteEvent = CompleteEvent & { taskId: string; title: string; estimatedMinutes: number };
export type StandaloneRevokeEvent = RevokeEvent & { completionId: string; taskId?: string };
export type StandaloneEvent = StandaloneCompleteEvent | StandaloneRevokeEvent;

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

/** True when `at` may be recorded: not more than MAX_FUTURE_SKEW_MS ahead of `now`, not more than MAX_EVENT_AGE_MS behind. */
export function isWithinEventWindow(at: Date, now: Date): boolean {
  const delta = at.getTime() - now.getTime();
  return delta <= MAX_FUTURE_SKEW_MS && delta >= -MAX_EVENT_AGE_MS;
}

const parseCompletionId = (raw: unknown, label: string): ValidationResult<string> =>
  typeof raw === 'string' && COMPLETION_ID_PATTERN.test(raw)
    ? { ok: true, value: raw }
    : fail(`${label} must be 1-64 characters of letters, digits, "-" or "_".`);

const parseInstant = (raw: unknown, label: string): ValidationResult<Date> => {
  const parsed = parseStartTime(raw);
  return parsed.ok
    ? { ok: true, value: parsed.value }
    : fail(`${label} must be an ISO 8601 date-time with a time zone (e.g. 2026-10-20T09:30:00Z).`);
};

function parseComplete(raw: Record<string, unknown>, prefix: string): ValidationResult<CompleteEvent> {
  const completionId = parseCompletionId(raw.completionId, `${prefix}.completionId`);
  if (!completionId.ok) return completionId;

  const completedAt = parseInstant(raw.completedAt, `${prefix}.completedAt`);
  if (!completedAt.ok) return completedAt;

  if (!isValidUtcOffsetMinutes(raw.utcOffsetMinutes)) {
    return fail(`${prefix}.utcOffsetMinutes is required: an integer number of minutes east of UTC between -720 and 840.`);
  }

  const localDate = localDateAt(completedAt.value, raw.utcOffsetMinutes);
  if (raw.localDate !== undefined) {
    if (!isValidCalendarDate(raw.localDate)) {
      return fail(`${prefix}.localDate must be a real calendar date in YYYY-MM-DD form.`);
    }
    if (raw.localDate !== localDate) {
      return fail(`${prefix}.localDate does not match completedAt at utcOffsetMinutes.`);
    }
  }

  return {
    ok: true,
    value: { kind: 'complete', completionId: completionId.value, completedAt: completedAt.value, utcOffsetMinutes: raw.utcOffsetMinutes, localDate },
  };
}

function parseRevoke(raw: Record<string, unknown>, prefix: string, requireId: boolean): ValidationResult<RevokeEvent> {
  let completionId: string | undefined;
  if (raw.completionId !== undefined || requireId) {
    const parsedId = parseCompletionId(raw.completionId, `${prefix}.completionId`);
    if (!parsedId.ok) return parsedId;
    completionId = parsedId.value;
  }

  const revokedAt = parseInstant(raw.revokedAt, `${prefix}.revokedAt`);
  if (!revokedAt.ok) return revokedAt;

  return { ok: true, value: { kind: 'revoke', ...(completionId ? { completionId } : {}), revokedAt: revokedAt.value } };
}

/**
 * `completionEvent` on a task write. Its kind is decided by `completed`, so the two can never contradict each other:
 * completed true carries a completion, completed false carries a revocation. Unknown keys are dropped.
 */
export function parseTaskCompletionEvent(raw: unknown, completed: boolean): ValidationResult<TaskCompletionEvent> {
  if (!isPlainObject(raw)) return fail('completionEvent must be an object.');
  return completed ? parseComplete(raw, 'completionEvent') : parseRevoke(raw, 'completionEvent', false);
}

/** Body of POST /api/completion-events. */
export function parseStandaloneEvent(body: unknown): ValidationResult<StandaloneEvent> {
  if (!isPlainObject(body)) return fail('Request body must be a JSON object.');

  if (body.type === 'complete') {
    const event = parseComplete(body, 'body');
    if (!event.ok) return event;

    const { taskId, title, estimatedMinutes } = body;
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > MAX_TASK_ID_LENGTH || !TASK_ID_PATTERN.test(taskId)) {
      return fail(`taskId must be 1-${MAX_TASK_ID_LENGTH} characters of letters, digits, "-" or "_".`);
    }
    if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > TITLE_MAX_LENGTH) {
      return fail(`title must be a non-empty string of at most ${TITLE_MAX_LENGTH} characters.`);
    }
    if (typeof estimatedMinutes !== 'number' || !isValidEstimatedMinutes(estimatedMinutes)) {
      return fail(`estimatedMinutes must be a finite number between 0 and ${ESTIMATED_MINUTES_MAX}.`);
    }
    return { ok: true, value: { ...event.value, taskId, title: title.trim(), estimatedMinutes } };
  }

  if (body.type === 'revoke') {
    const event = parseRevoke(body, 'body', true);
    if (!event.ok) return event;

    let taskId: string | undefined;
    if (body.taskId !== undefined) {
      if (typeof body.taskId !== 'string' || body.taskId.length === 0 || body.taskId.length > MAX_TASK_ID_LENGTH || !TASK_ID_PATTERN.test(body.taskId)) {
        return fail(`taskId must be 1-${MAX_TASK_ID_LENGTH} characters of letters, digits, "-" or "_".`);
      }
      taskId = body.taskId;
    }
    return { ok: true, value: { ...event.value, completionId: event.value.completionId as string, ...(taskId ? { taskId } : {}) } };
  }

  return fail("type must be 'complete' or 'revoke'.");
}
