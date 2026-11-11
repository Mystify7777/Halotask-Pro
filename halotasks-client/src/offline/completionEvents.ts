import type { CompleteEventPayload, RevokeEventPayload, Task, TaskCompletionEventPayload } from '../types/task';
import { getUtcOffsetMinutes } from '../utils/localDate';
import { enqueueSyncAction } from './syncQueue';

// ── Client completion events (Issue #47, Phase 2E) ──────────────────────────────────────────────────────────────
//
// A completion event is created ONCE, at the moment the user completes (or re-opens) a task, and its `completionId` never
// changes afterwards: not across a retry, a reload, a queue replay or the local-id remap. The server is idempotent by that id
// (halotasks-server/src/utils/completionRecords.ts), so "send it again" is always safe, and one completion can only ever be
// one record. The event carries the established server contract (completionId, completedAt, utcOffsetMinutes) and nothing
// that depends on the task document staying alive: the title and estimate are snapshotted into the event so that a task
// deleted before delivery still leaves its completion in history.
//
// ONE function decides a completion transition for every writer (dashboard checkbox, bulk complete, Insights toggle), so the
// "is this a completion or a revocation, and with which id" rule exists once.

/** Same shape the server accepts for a completion id (and a subtask id). */
export const COMPLETION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_TITLE_LENGTH = 200; // halotasks-server TITLE_MAX_LENGTH
const MAX_ESTIMATED_MINUTES = 100_000; // halotasks-server ESTIMATED_MINUTES_MAX

export const newCompletionId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * What a `completion` queue entry holds. `kind: 'complete'` always has completionId, completedAt and utcOffsetMinutes;
 * `kind: 'revoke'` has revokedAt, and completionId only when the task named the completion it holds. `title` and
 * `estimatedMinutes` are the snapshot a standalone delivery needs (the task may be gone by then).
 */
export type CompletionEntryPayload = {
  kind: 'complete' | 'revoke';
  completionId?: string;
  completedAt?: string;
  utcOffsetMinutes?: number;
  revokedAt?: string;
  title: string;
  estimatedMinutes: number;
};

export type CompletionTransition = {
  /** The `completed` value the task write asks for. */
  completed: boolean;
  /** Rides the task write online (`PUT /api/tasks/:id` with `completed`). */
  event: TaskCompletionEventPayload;
  /** Stored in the sync queue when the write has to wait. */
  entry: CompletionEntryPayload;
  /** Applied to the local task right away (optimistic state). */
  localPatch: Pick<Task, 'completed' | 'completedAt' | 'completionId'> | Pick<Task, 'completed' | 'completedAt'>;
};

const snapshotOf = (task: Task): { title: string; estimatedMinutes: number } => {
  const title = typeof task.title === 'string' ? task.title.trim().slice(0, MAX_TITLE_LENGTH) : '';
  const minutes = task.estimatedMinutes;
  return {
    title: title.length > 0 ? title : '(untitled)',
    estimatedMinutes: typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 ? Math.min(minutes, MAX_ESTIMATED_MINUTES) : 0,
  };
};

/**
 * The transition that flips `task`'s completion. Reads the task it is given: callers pass the LATEST state of the task.
 *  - not completed -> a completion with a NEW id, the instant now and the device's offset AT that instant (DST-correct);
 *  - completed -> a revocation naming the completion the task holds, when it holds one. A task completed before records
 *    existed holds none; its revocation names nothing and the server revokes whatever it holds (best effort, as for any
 *    legacy client).
 * `completedAt` is set on the local task so the local day of an offline completion is the day the user acted.
 */
export const makeCompletionTransition = (task: Task, now: Date = new Date()): CompletionTransition => {
  const snapshot = snapshotOf(task);
  const at = now.toISOString();

  if (!task.completed) {
    const event: CompleteEventPayload = { completionId: newCompletionId(), completedAt: at, utcOffsetMinutes: getUtcOffsetMinutes(now) };
    return {
      completed: true,
      event,
      entry: { kind: 'complete', ...event, ...snapshot },
      localPatch: { completed: true, completedAt: at, completionId: event.completionId },
    };
  }

  const held = typeof task.completionId === 'string' && COMPLETION_ID_PATTERN.test(task.completionId) ? task.completionId : undefined;
  const event: RevokeEventPayload = { ...(held ? { completionId: held } : {}), revokedAt: at };
  return {
    completed: false,
    event,
    entry: { kind: 'revoke', ...event, ...snapshot },
    // the task keeps its pointer while open (the server does the same): it names the completion that was last held
    localPatch: { completed: false, completedAt: null },
  };
};

/**
 * Queues the event. A `completion` entry is never merged into another entry and is never dropped by a later delete of the
 * task (see syncQueue.ts). Queuing the same event twice (same kind and completionId) stores it once.
 */
export const enqueueCompletion = (taskId: string, entry: CompletionEntryPayload) =>
  enqueueSyncAction({ type: 'completion', taskId, payload: entry });

/**
 * Reads a queue entry's payload back as a CompletionEntryPayload, or null when it is not a well-formed one. Queue data
 * comes from storage, so nothing is sent on trust: a malformed entry is never delivered (the processor discards it).
 */
export const parseCompletionEntry = (raw: unknown): CompletionEntryPayload | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const isInstant = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(new Date(v).getTime());
  const idOk = (v: unknown): v is string => typeof v === 'string' && COMPLETION_ID_PATTERN.test(v);
  if (typeof p.title !== 'string' || p.title.trim().length === 0 || p.title.length > MAX_TITLE_LENGTH) return null;
  if (typeof p.estimatedMinutes !== 'number' || !Number.isFinite(p.estimatedMinutes) || p.estimatedMinutes < 0 || p.estimatedMinutes > MAX_ESTIMATED_MINUTES) {
    return null;
  }
  const base = { title: p.title, estimatedMinutes: p.estimatedMinutes };

  if (p.kind === 'complete') {
    if (!idOk(p.completionId) || !isInstant(p.completedAt)) return null;
    if (typeof p.utcOffsetMinutes !== 'number' || !Number.isInteger(p.utcOffsetMinutes) || p.utcOffsetMinutes < -720 || p.utcOffsetMinutes > 840) return null;
    return { kind: 'complete', completionId: p.completionId, completedAt: p.completedAt, utcOffsetMinutes: p.utcOffsetMinutes, ...base };
  }
  if (p.kind === 'revoke') {
    if (!isInstant(p.revokedAt)) return null;
    if (p.completionId !== undefined && !idOk(p.completionId)) return null;
    return { kind: 'revoke', ...(p.completionId !== undefined ? { completionId: p.completionId } : {}), revokedAt: p.revokedAt, ...base };
  }
  return null;
};
