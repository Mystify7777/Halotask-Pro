import { captureSession, isSameSession, isSessionChangedError } from '../services/api';
import { taskService } from '../services/taskService';
import { TaskCreatePayload, TaskUpdatePayload, Task } from '../types/task';
import type { GrowthResult } from '../growth/treeTypes';
import { getSyncQueue, setSyncQueue, SyncQueueRecord } from './syncQueue';

/**
 * The queue merges later edits into earlier entries ({...old, ...new}), so a merged payload can in principle hold a due
 * time next to a cleared or missing due date. The server rejects that with a 400, and a 400 permanently discards the
 * entry, which would lose the user's whole edit. A due time only exists next to a due date, so drop it here; the server
 * still validates everything that is sent.
 */
export const withConsistentDeadline = <T extends { dueDate?: string | null; dueTime?: string | null }>(
  payload: T,
  kind: 'create' | 'update',
): T => {
  if (payload.dueTime === undefined || payload.dueTime === null) return payload;
  // A create has no stored date to fall back on; an update only loses its time when it clears the date itself.
  const hasNoDueDate = kind === 'create' ? !payload.dueDate : 'dueDate' in payload && !payload.dueDate;
  return hasNoDueDate ? { ...payload, dueTime: null } : payload;
};

/**
 * The server answers 409 to an update that sets a due time and relies on the task's stored due date when that date was
 * removed meanwhile (for example on another device). The edit is not wrong, the world changed under it, so it must not
 * be discarded like a permanent 4xx. See reconcileDueDateConflict.
 */
const isDueDateConflict = (error: unknown, payload: TaskUpdatePayload): boolean =>
  httpStatusOf(error) === 409 && typeof payload.dueTime === 'string' && payload.dueDate === undefined;

/**
 * Reconciliation for that conflict, bounded to ONE extra request per queue run (never a retry loop): resend the edit
 * with its due time cleared. Every other field of the edit still lands, and the server's answer, which has no due date,
 * replaces the local copy so the UI stops showing a time the server cannot hold. The user is told (onDueTimeConflict)
 * that the due time was not kept. If this request itself fails, the original entry is kept or handled like any other
 * failure; nothing is retried in a loop.
 */
const withoutDueTime = (payload: TaskUpdatePayload): TaskUpdatePayload => ({ ...payload, dueTime: null });

type ProcessSyncQueueParams = {
  onTaskCreated: (localTaskId: string, serverTask: Task) => void;
  onTaskUpdated: (taskId: string, serverTask: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  /**
   * The server's Growth Tree answer to a replayed completion (Issue #24). Called only while the owner is
   * still signed in, like the other callbacks. Optional: callers that do not show the tree can omit it.
   */
  onGrowth?: (growth: GrowthResult) => void;
  /**
   * A queued due-time edit could not be kept because the task's due date was removed on the server. The rest of the
   * edit was applied (and passed to onTaskUpdated). Optional so callers that show no messages can omit it.
   */
  onDueTimeConflict?: (taskId: string, dueTime: string) => void;
};

export type ProcessSyncQueueResult = {
  processed: number;
  failed: number;
  remaining: number;
};

function httpStatusOf(error: unknown): number | null {
  const status =
    typeof error === 'object' &&
    error !== null &&
    'response' in error &&
    typeof (error as { response?: unknown }).response === 'object' &&
    (error as { response: { status?: unknown } }).response !== null
      ? (error as { response: { status?: number } }).response?.status
      : null;

  return typeof status === 'number' ? status : null;
}

/**
 * 401 means the session is not accepted right now (expired, or revoked by a password reset) — a
 * statement about the CREDENTIAL, not about the queued action. The action is fine and will succeed
 * after the user signs in again, so it must be kept, not discarded.
 */
function isAuthError(error: unknown): boolean {
  return httpStatusOf(error) === 401;
}

/**
 * Returns true for HTTP status codes that are permanent client errors.
 * Retrying these entries will not succeed, so they should be discarded.
 * (401 is deliberately not one of them — see isAuthError.)
 */
function isPermanentError(error: unknown): boolean {
  const status = httpStatusOf(error);

  if (status === null || status === 401) {
    return false;
  }

  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export const processSyncQueue = async ({
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onGrowth,
  onDueTimeConflict,
}: ProcessSyncQueueParams): Promise<ProcessSyncQueueResult> => {
  // A queue may only be worked by its owner, with the owner's credential. Bind BOTH now — the account
  // and the token it is signed in with — and use them for everything below:
  //  - every read/write of the queue names the owner: after a 401 the response interceptor signs the user
  //    out, so by the time we write back "the current account" is nobody (or, after a quick re-login,
  //    somebody else);
  //  - every request carries the bound session. Checking "is the owner still signed in?" before calling
  //    the service is not enough, because the service builds the request later and used to read whichever
  //    token was current THEN. The API client now verifies the bound session and applies the bound token
  //    in one synchronous step, or refuses to send (SessionChangedError).
  const session = captureSession();

  if (!session) {
    return { processed: 0, failed: 0, remaining: 0 };
  }

  const ownerId = session.userId;
  const stillSignedIn = () => isSameSession(captureSession(), session);
  const queue = await getSyncQueue(ownerId);

  if (queue.length === 0) {
    return {
      processed: 0,
      failed: 0,
      remaining: 0,
    };
  }

  const idMap = new Map<string, string>();
  const remainingQueue: SyncQueueRecord[] = [];
  let processed = 0;

  for (const [index, entry] of queue.entries()) {
    // Early exit only (saves building a request that would be refused). The API client's check at send
    // time is the real guard; this one cannot be, because the account can still change after it.
    if (!stillSignedIn()) {
      remainingQueue.push(...queue.slice(index));
      break;
    }

    try {
      if (entry.type === 'create') {
        const localTaskId = entry.taskId;
        const payload = withConsistentDeadline((entry.payload ?? {}) as TaskCreatePayload, 'create');
        const response = await taskService.createTask(payload, { session });

        if (localTaskId) {
          idMap.set(localTaskId, response.task._id);
          // The request went out as the owner and is done. But if another account is on screen now, do
          // not feed the owner's result into that account's UI state and task cache.
          if (stillSignedIn()) onTaskCreated(localTaskId, response.task);
        }
        if (response.growth && stillSignedIn()) onGrowth?.(response.growth);

        processed += 1;
        continue;
      }

      if (entry.type === 'update') {
        const sourceTaskId = entry.taskId;
        if (!sourceTaskId) {
          processed += 1;
          continue;
        }

        const resolvedTaskId = idMap.get(sourceTaskId) ?? sourceTaskId;

        if (resolvedTaskId.startsWith('local-')) {
          remainingQueue.push(entry);
          continue;
        }

        const payload = withConsistentDeadline((entry.payload ?? {}) as TaskUpdatePayload, 'update');
        let response;
        let conflictedDueTime: string | null = null;
        try {
          response = await taskService.updateTask(resolvedTaskId, payload, { session });
        } catch (error) {
          if (!isDueDateConflict(error, payload)) throw error;
          conflictedDueTime = payload.dueTime as string;
          response = await taskService.updateTask(resolvedTaskId, withoutDueTime(payload), { session });
        }
        if (stillSignedIn()) onTaskUpdated(resolvedTaskId, response.task);
        if (conflictedDueTime !== null && stillSignedIn()) onDueTimeConflict?.(resolvedTaskId, conflictedDueTime);
        if (response.growth && stillSignedIn()) onGrowth?.(response.growth);

        processed += 1;
        continue;
      }

      if (entry.type === 'delete') {
        const sourceTaskId = entry.taskId;
        if (!sourceTaskId) {
          processed += 1;
          continue;
        }

        const resolvedTaskId = idMap.get(sourceTaskId) ?? sourceTaskId;

        if (resolvedTaskId.startsWith('local-')) {
          processed += 1;
          continue;
        }

        await taskService.deleteTask(resolvedTaskId, { session });
        if (stillSignedIn()) onTaskDeleted(resolvedTaskId);

        processed += 1;
      }
    } catch (error) {
      if (isSessionChangedError(error)) {
        // The account or token changed between building this request and sending it, and the API client
        // refused to send it. Nothing was sent. Keep this entry and everything not yet attempted for the
        // owner; do not retry under whoever is signed in now.
        remainingQueue.push(...queue.slice(index));
        break;
      }

      if (isAuthError(error)) {
        // Stop here. The response interceptor has already signed the user out, so every further
        // request would go out without credentials, fail the same way, and (before this) be thrown
        // away one by one. Keep this entry and everything not yet attempted, in order, for the next
        // run after the user signs in again.
        remainingQueue.push(...queue.slice(index));
        break;
      }

      if (isPermanentError(error)) {
        console.warn('[syncQueue] Discarding permanently failed entry:', entry.type, entry.taskId, error);
        processed += 1;
        continue;
      }

      remainingQueue.push(entry);
    }
  }

  await setSyncQueue(remainingQueue, ownerId);

  return {
    processed,
    failed: remainingQueue.length,
    remaining: remainingQueue.length,
  };
};
