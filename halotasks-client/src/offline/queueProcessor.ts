import { captureSession, isSameSession, isSessionChangedError } from '../services/api';
import { taskService } from '../services/taskService';
import { TaskCreatePayload, Task } from '../types/task';
import type { GrowthResult } from '../growth/treeTypes';
import { getSyncQueue, setSyncQueue, SyncQueueRecord } from './syncQueue';

type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate'> & {
  completed?: boolean;
  dueDate?: string | null;
};

type ProcessSyncQueueParams = {
  onTaskCreated: (localTaskId: string, serverTask: Task) => void;
  onTaskUpdated: (taskId: string, serverTask: Task) => void;
  onTaskDeleted: (taskId: string) => void;
  /**
   * The server's Growth Tree answer to a replayed completion (Issue #24). Called only while the owner is
   * still signed in, like the other callbacks. Optional: callers that do not show the tree can omit it.
   */
  onGrowth?: (growth: GrowthResult) => void;
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
        const payload = (entry.payload ?? {}) as TaskCreatePayload;
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

        const payload = (entry.payload ?? {}) as TaskUpdatePayload;
        const response = await taskService.updateTask(resolvedTaskId, payload, { session });
        if (stillSignedIn()) onTaskUpdated(resolvedTaskId, response.task);
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
