import { captureSession, isSameSession, isSessionChangedError } from '../services/api';
import { taskService } from '../services/taskService';
import { TaskCreatePayload, TaskUpdatePayload, Task, TaskCompletionEventPayload, TaskResponse } from '../types/task';
import type { GrowthResult } from '../growth/treeTypes';
import { completionService, type StandaloneEventBody } from '../services/completionService';
import { httpStatusOf, isPermanentError } from './deliveryErrors';
import { parseCompletionEntry, type CompletionEntryPayload } from './completionEvents';
import { ensureMutationIds, settleSyncQueueAndTasks, SettledEntry, type SyncQueueRecord } from './syncQueue';
import { adoptServerAnswer } from './localMutations';
import { adoptCreated, adoptDeleted, adoptUpdated } from './taskReconcile';
import { COMPLETION_STATE_FIELDS } from './queueActions';
import { createBatchTransport, payloadAppliedBy, type PlannedMutation } from './batchTransport';
import type { TaskRef } from './batchProtocol';
import type { BlockedReason } from './syncState';
import { TaskConflictError, type ConflictedMutation } from './conflicts';

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
 * The `code` the server puts in the body of the 409 it returns when an update sets a due time against the stored due
 * date and that date was removed before the write (Issue #43). Must match halotasks-server TASK_DUE_DATE_REMOVED.
 */
export const TASK_DUE_DATE_REMOVED = 'TASK_DUE_DATE_REMOVED';

/**
 * True only for that exact conflict: a 409 whose body is an object with `code` strictly equal to the code above. The
 * message text and the payload are never consulted for the decision, and any other shape (no body, a string, an
 * array, a missing, wrong-typed or different code) is NOT this conflict, so every other 409 takes the normal error
 * path. The edit must also carry a due time, since that is what the recovery sends again, cleared.
 */
const isDueDateConflict = (error: unknown, payload: TaskUpdatePayload): boolean => {
  if (httpStatusOf(error) !== 409 || typeof payload.dueTime !== 'string') return false;
  const body = (error as { response?: { data?: unknown } }).response?.data;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  return (body as { code?: unknown }).code === TASK_DUE_DATE_REMOVED;
};

/**
 * Recovery for that conflict, bounded to ONE extra request per queue run (never a retry loop): resend the edit with
 * its due time cleared. Every other field of the edit still lands, and the server's answer, which has no due date,
 * replaces the local copy so the UI stops showing a time the server cannot hold. The user is told (onDueTimeConflict)
 * that the due time was not kept. If this request itself fails, the original entry is kept or handled like any other
 * failure; nothing is retried in a loop.
 */
const toTaskEvent = (event: CompletionEntryPayload): TaskCompletionEventPayload =>
  event.kind === 'complete'
    ? { completionId: event.completionId as string, completedAt: event.completedAt as string, utcOffsetMinutes: event.utcOffsetMinutes as number }
    : { ...(event.completionId ? { completionId: event.completionId } : {}), revokedAt: event.revokedAt as string };

const withoutDueTime = (payload: TaskUpdatePayload): TaskUpdatePayload => ({ ...payload, dueTime: null });

/**
 * Whether the server's answer is already out of date on arrival (Issue #57): the user made further changes to the task
 * while this run was waiting on the network. A stale answer must not replace the local copy, which is ahead of it.
 */
export type AnswerContext = { stale: boolean };

type ProcessSyncQueueParams = {
  /**
   * A queued create reached the server. When `stale`, only the identity (the server's id) is theirs to adopt: the user
   * changed the task since, and those changes are still queued.
   */
  onTaskCreated: (localTaskId: string, serverTask: Task, context: AnswerContext) => void;
  onTaskUpdated: (taskId: string, serverTask: Task, context: AnswerContext) => void;
  onTaskDeleted: (taskId: string) => void;
  /**
   * The task list as it was STORED by an adoption or by the end-of-run settle (Issue #61). The processor writes the list itself, in
   * the same transaction that decides whether an answer is stale; this hands that list to the caller to show. The other callbacks
   * above are notifications and no longer write anything. Optional.
   */
  onTasksStored?: (tasks: Task[]) => void;
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
  /**
   * Called once at the end of a run in which at least one completion event was delivered (Issue #47, Phase 2E). Delivery
   * means the server stored (or already had) the event; it is NOT the canonical acknowledgement, which only a canonical
   * history answer gives. The caller uses this to ask for a history reconcile. Optional.
   */
  onCompletionsDelivered?: () => void;
};

/**
 * A queued mutation the server refused for good (a permanent 4xx). It was removed from the queue and never retried; the
 * caller reports it and reads the server's state back (Issue #57). Not persisted anywhere: that is #58's model.
 */
export type RejectedMutation = {
  type: SyncQueueRecord['type'];
  taskId: string | null;
  /** The task's title when the entry carried one (a create, an edit that changed it, a completion's snapshot). */
  title: string | null;
  status: number | null;
};

export type ProcessSyncQueueResult = {
  processed: number;
  failed: number;
  remaining: number;
  rejected: RejectedMutation[];
  /**
   * Edits the server did NOT apply because another device changed a field first (Issue #62B). Each entry was removed from the queue;
   * the caller shows it until the person chooses Keep mine or Use theirs (session memory only, D7). Optional so a caller that builds
   * a result by hand need not know about it.
   */
  conflicts?: ConflictedMutation[];
  /**
   * Why the run stopped with work left (Issue #58): `auth` = the session is not accepted (401, or the account changed
   * mid-run), `unreachable` = a request failed in a way that is neither a refusal nor an auth problem (network, timeout,
   * 5xx), so the server may not have received it. `null` when nothing stopped the run. A refusal is NOT blocked: it is in
   * `rejected`. Entries that merely wait behind an unsynced create are not blocked either.
   */
  blocked: BlockedReason | null;
};

/**
 * 401 means the session is not accepted right now (expired, or revoked by a password reset) — a
 * statement about the CREDENTIAL, not about the queued action. The action is fine and will succeed
 * after the user signs in again, so it must be kept, not discarded.
 */
function isAuthError(error: unknown): boolean {
  return httpStatusOf(error) === 401;
}

/**
 * A server answer describes the task as the server has it NOW. When completion events for the same task are still waiting
 * behind it, the user has already gone further (completed it, or re-opened it), and the local copy shows that. So the task
 * adopted into the UI is the server's, with those waiting events laid over its completion fields: nothing the user did is
 * shown as undone while it is still on its way.
 */
const withPendingCompletions = (serverTask: Task, waiting: SyncQueueRecord[]): Task => {
  let task = serverTask;
  for (const item of waiting) {
    const event = parseCompletionEntry(item.payload);
    if (!event) continue;
    task =
      event.kind === 'complete'
        ? { ...task, completed: true, completedAt: event.completedAt, completionId: event.completionId }
        : { ...task, completed: false, completedAt: null };
  }
  return task;
};

/** `code` of a 4xx answer body, or null. Only the code is ever consulted, never the message. */
const errorCodeOf = (error: unknown): string | null => {
  const body = (error as { response?: { data?: unknown } })?.response?.data;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
};

/**
 * The server's code for "this task still exists, so the event belongs on the task write" (POST /api/completion-events).
 * Must match halotasks-server COMPLETION_TASK_EXISTS.
 */
export const COMPLETION_TASK_EXISTS = 'COMPLETION_TASK_EXISTS';

const standaloneBodyOf = (taskId: string, event: CompletionEntryPayload): StandaloneEventBody | null => {
  if (event.kind === 'complete') {
    return {
      type: 'complete',
      completionId: event.completionId as string,
      taskId,
      title: event.title,
      estimatedMinutes: event.estimatedMinutes,
      completedAt: event.completedAt as string,
      utcOffsetMinutes: event.utcOffsetMinutes as number,
    };
  }
  // A revoke can only be delivered by the id it ends: with none, there is nothing the server could look up.
  return event.completionId ? { type: 'revoke', completionId: event.completionId, taskId, revokedAt: event.revokedAt as string } : null;
};

/** What a local task id looks like to the server (`local-<uuid>`): the key a retried create is recognised by. */
const LOCAL_KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;

const titleOfEntry = (entry: SyncQueueRecord): string | null => {
  const title = (entry.payload as { title?: unknown } | undefined)?.title;
  return typeof title === 'string' && title.trim() ? title : null;
};

const runSyncQueue = async ({
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
  onTasksStored,
  onGrowth,
  onDueTimeConflict,
  onCompletionsDelivered,
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
    return { processed: 0, failed: 0, remaining: 0, rejected: [], conflicts: [], blocked: null };
  }

  const ownerId = session.userId;
  const stillSignedIn = () => isSameSession(captureSession(), session);
  // Every entry has the id its current payload is sent under, stored BEFORE anything is sent (Issue #60).
  const queue = await ensureMutationIds(ownerId);

  if (queue.length === 0) {
    return {
      processed: 0,
      failed: 0,
      remaining: 0,
      rejected: [],
      conflicts: [],
      blocked: null,
    };
  }

  const idMap = new Map<string, string>();
  const rejected: RejectedMutation[] = [];
  const conflicts: ConflictedMutation[] = [];
  // What was queued when this run started. Work the user did while a request was out is either a NEW entry or a change
  // merged into an entry that was already here (an edit merges into a queued update or create): both show up as a difference.
  const snapshotPayloads = new Map(queue.map((item) => [item.id, JSON.stringify(item.payload ?? null)]));
  // Whether an answer is stale (the user did more to the task while it was in flight) is decided by adoptServerAnswer, INSIDE the
  // transaction that writes the task list, from the queue as it is at that moment (Issue #61). `snapshotPayloads` is what it compares to.
  const adopt = (taskIds: string[], apply: (stored: Task[], context: { stale: boolean }) => Task[], alsoStale = false) =>
    adoptServerAnswer({ ownerId, taskIds, snapshot: snapshotPayloads, alsoStale, apply });
  // ── Batch (Issue #60) ─────────────────────────────────────────────────────────────────────────────────────────────────
  // The entries the loop below WOULD send, in queue order, go out in batches first; the loop then asks the transport for each
  // entry's answer. Planning mirrors the loop's own decisions: an entry the loop settles locally (nothing to send it to, an
  // unsynced create it waits behind, a delete of a task the server never saw) is not planned, and neither is anything that
  // needs the single-task request (a completion for a task that only exists locally is delivered standalone). A task that
  // only has a local id is named by it (`localId`): the server resolves it through the create planned ahead of it.
  const planBatch = (): PlannedMutation[] => {
    const plan: PlannedMutation[] = [];
    const planned = new Set<string>(); // local ids whose create is in this plan
    for (const entry of queue) {
      const mutationId = entry.mutationId;
      const taskId = entry.taskId;
      if (!mutationId) continue;
      if (entry.type === 'create') {
        if (!taskId || !LOCAL_KEY_PATTERN.test(taskId)) continue; // no usable key: the single request (which has none either)
        plan.push({ entryId: entry.id, mutation: { mutationId, type: 'create', localId: taskId, payload: withConsistentDeadline((entry.payload ?? {}) as TaskCreatePayload, 'create') } });
        planned.add(taskId);
        continue;
      }
      if (!taskId) continue;
      const isLocal = taskId.startsWith('local-');
      if (isLocal && !planned.has(taskId)) continue;
      const task: TaskRef = isLocal ? { localId: taskId } : { id: taskId };
      if (entry.type === 'update') {
        const payload = withConsistentDeadline((entry.payload ?? {}) as TaskUpdatePayload, 'update');
        if (COMPLETION_STATE_FIELDS.some((field) => field in payload)) continue; // completion state goes through its own entry type
        // Issue #62B: the base goes with the mutation only when there is something to check; without it the server is last-write-wins.
        const base = entry.base && Object.keys(entry.base).length > 0 ? entry.base : undefined;
        plan.push({ entryId: entry.id, mutation: { mutationId, type: 'update', task, payload, ...(base ? { base } : {}) } });
      } else if (entry.type === 'completion') {
        const event = parseCompletionEntry(entry.payload);
        if (!event) continue;
        plan.push({ entryId: entry.id, mutation: { mutationId, type: 'completion', task, payload: { completed: event.kind === 'complete', completionEvent: toTaskEvent(event) } } });
      } else {
        plan.push({ entryId: entry.id, mutation: { mutationId, type: 'delete', task } });
      }
    }
    return plan;
  };
  const transport = await createBatchTransport(planBatch(), session);

  // What happened to each entry, by queue-entry id. Everything NOT listed here is still queued. The queue is written back
  // by settleSyncQueue against the queue as it is at the end of the run, so edits made while this run waited on the
  // network are never overwritten.
  const settled = new Map<string, SettledEntry>();
  const sentCreates = new Map<string, string>(); // create entry id -> server id, to notice a delete made while it was in flight
  let processed = 0;
  let deliveredCompletions = 0;
  let blocked: BlockedReason | null = null;

  for (const [index, entry] of queue.entries()) {
    // Early exit only (saves building a request that would be refused). The API client's check at send
    // time is the real guard; this one cannot be, because the account can still change after it.
    // An answer already in hand needs no request, so it is settled even if the account changed meanwhile (the callbacks below
    // still check); anything that would send a request first needs the owner to be signed in.
    if (!stillSignedIn() && !transport.holds(entry.id)) {
      blocked = 'auth';
      break;
    }

    try {
      if (entry.type === 'create') {
        const localTaskId = entry.taskId;
        const payload = withConsistentDeadline((entry.payload ?? {}) as TaskCreatePayload, 'create');
        const response = await transport.answer<TaskResponse & { replayed?: boolean }>(entry.id, () =>
          taskService.createTask(payload, { session }),
        );
        // A REPLAYED create was applied by an earlier request, and the entry may have changed since: only what the server's task
        // already holds counts as sent, so the rest is queued as an update (see payloadAppliedBy).
        const sentPayload = response.replayed ? payloadAppliedBy(response.task, entry.payload) : entry.payload;
        const partlyApplied = response.replayed === true && Object.keys(sentPayload ?? {}).length !== Object.keys(entry.payload ?? {}).length;
        settled.set(entry.id, { outcome: 'sent', payload: sentPayload, serverTaskId: response.task._id });
        sentCreates.set(entry.id, response.task._id);

        if (localTaskId) {
          idMap.set(localTaskId, response.task._id);
          // The request went out as the owner and is done. But if another account is on screen now, do
          // not feed the owner's result into that account's UI state and task cache.
          const waiting = queue.slice(index + 1).filter((item) => item.type === 'completion' && item.taskId === localTaskId);
          if (stillSignedIn()) {
            const adopted = withPendingCompletions(response.task, waiting);
            const outcome = await adopt([localTaskId], (stored, { stale }) => adoptCreated(stored, localTaskId, adopted, stale), partlyApplied);
            onTaskCreated(localTaskId, adopted, { stale: outcome.stale });
            onTasksStored?.(outcome.tasks);
          }
        }
        if (response.growth && stillSignedIn()) onGrowth?.(response.growth);

        processed += 1;
        continue;
      }

      if (entry.type === 'update') {
        const sourceTaskId = entry.taskId;
        if (!sourceTaskId) {
          settled.set(entry.id, { outcome: 'discarded' }); // nothing to send it to
          processed += 1;
          continue;
        }

        const resolvedTaskId = idMap.get(sourceTaskId) ?? sourceTaskId;

        if (resolvedTaskId.startsWith('local-')) {
          continue; // its create has not synced: stays queued, in order
        }

        const payload = withConsistentDeadline((entry.payload ?? {}) as TaskUpdatePayload, 'update');
        let response;
        let conflictedDueTime: string | null = null;
        try {
          response = await transport.answer(entry.id, () => taskService.updateTask(resolvedTaskId, payload, { session }));
        } catch (error) {
          if (!isDueDateConflict(error, payload)) throw error;
          conflictedDueTime = payload.dueTime as string;
          response = await taskService.updateTask(resolvedTaskId, withoutDueTime(payload), { session });
        }
        // the server's task is carried along: a residual edit is based on what the server STORED (normalised), not on what was sent
        settled.set(entry.id, { outcome: 'sent', payload: entry.payload, serverTaskId: resolvedTaskId, serverTask: response.task });
        // A completion waiting behind this edit means the local copy is ahead of this answer: it is not adopted (the answer to
        // that completion will be).
        const completionWaits = queue.slice(index + 1).some((item) => item.type === 'completion' && item.taskId === sourceTaskId);
        if (!completionWaits && stillSignedIn()) {
          const outcome = await adopt([sourceTaskId, resolvedTaskId], (stored, { stale }) => adoptUpdated(stored, resolvedTaskId, response.task, stale));
          if (!outcome.stale) onTaskUpdated(resolvedTaskId, response.task, { stale: false });
          onTasksStored?.(outcome.tasks);
        }
        if (conflictedDueTime !== null && stillSignedIn()) onDueTimeConflict?.(resolvedTaskId, conflictedDueTime);
        if (response.growth && stillSignedIn()) onGrowth?.(response.growth);

        processed += 1;
        continue;
      }

      if (entry.type === 'completion') {
        const sourceTaskId = entry.taskId;
        const event = parseCompletionEntry(entry.payload);
        if (!sourceTaskId || !event) {
          // Nothing to send it to, or not a well-formed event (storage damage): never sent, never retried.
          console.warn('[syncQueue] Discarding malformed completion entry:', entry.id);
          settled.set(entry.id, { outcome: 'discarded' });
          processed += 1;
          continue;
        }

        let resolvedTaskId = idMap.get(sourceTaskId) ?? sourceTaskId;
        if (resolvedTaskId.startsWith('local-')) {
          const createEntry = queue.find((item) => item.type === 'create' && item.taskId === sourceTaskId);
          if (createEntry) {
            if (settled.get(createEntry.id)?.outcome === 'discarded') {
              // The task was refused for good, so it never existed on the server: there is no completion to record.
              settled.set(entry.id, { outcome: 'discarded' });
              processed += 1;
              continue;
            }
            continue; // its create has not synced: this stays queued, in order, right behind it
          }
          // No create is queued for it any more: the task was created and deleted offline. The completion still happened,
          // so it is delivered on its own, under the id it was made with (the server stores it exactly as received).
        }

        // Does a LATER entry of the same task follow (a re-open after this completion)? Then this answer is a step, not the
        // final state, and must not overwrite what the user sees: the local task already shows where the user ended up.
        const laterForTask = queue.slice(index + 1).some((item) => item.taskId === sourceTaskId && item.type !== 'delete');

        let delivered = false;
        if (!resolvedTaskId.startsWith('local-')) {
          try {
            const response = await transport.answer(entry.id, () =>
              taskService.updateTask(resolvedTaskId, { completed: event.kind === 'complete', completionEvent: toTaskEvent(event) }, { session }),
            );
            delivered = true;
            settled.set(entry.id, { outcome: 'sent', payload: entry.payload, serverTaskId: resolvedTaskId });
            if (!laterForTask && stillSignedIn()) {
              const outcome = await adopt([sourceTaskId, resolvedTaskId], (stored, { stale }) => adoptUpdated(stored, resolvedTaskId, response.task, stale));
              if (!outcome.stale) onTaskUpdated(resolvedTaskId, response.task, { stale: false });
              onTasksStored?.(outcome.tasks);
            }
            if (response.growth && stillSignedIn()) onGrowth?.(response.growth);
          } catch (error) {
            // 404: the task is gone from the server (deleted by another device, or after this entry was queued). The event
            // is still real: deliver it standalone. Every other failure takes the normal path below.
            if (httpStatusOf(error) !== 404) throw error;
          }
        }

        if (!delivered) {
          const body = standaloneBodyOf(resolvedTaskId, event);
          if (!body) {
            console.warn('[syncQueue] Discarding a revoke that names no completion for a task that is gone:', entry.id);
            settled.set(entry.id, { outcome: 'discarded' });
            processed += 1;
            continue;
          }
          try {
            await completionService.postEvent(body, { session });
          } catch (error) {
            // The task turned out to exist after all: the event belongs on the task write, so it stays queued for the next run.
            if (httpStatusOf(error) === 409 && errorCodeOf(error) === COMPLETION_TASK_EXISTS) continue;
            throw error;
          }
          settled.set(entry.id, { outcome: 'sent', payload: entry.payload, serverTaskId: null });
        }

        deliveredCompletions += 1;
        processed += 1;
        continue;
      }

      if (entry.type === 'delete') {
        const sourceTaskId = entry.taskId;
        if (!sourceTaskId) {
          settled.set(entry.id, { outcome: 'discarded' }); // nothing to send it to
          processed += 1;
          continue;
        }

        const resolvedTaskId = idMap.get(sourceTaskId) ?? sourceTaskId;

        if (resolvedTaskId.startsWith('local-')) {
          settled.set(entry.id, { outcome: 'discarded' }); // never reached the server, so there is nothing to delete
          processed += 1;
          continue;
        }

        try {
          await transport.answer(entry.id, () => taskService.deleteTask(resolvedTaskId, { session }));
        } catch (error) {
          // The task is already gone (deleted on another device, or by an earlier attempt whose answer was lost): what the user
          // wanted has happened. Treating the 404 as a refusal would report "Not saved" for a delete that worked.
          if (httpStatusOf(error) !== 404) throw error;
        }
        settled.set(entry.id, { outcome: 'sent', payload: entry.payload, serverTaskId: resolvedTaskId });
        if (stillSignedIn()) {
          const outcome = await adopt([sourceTaskId, resolvedTaskId], (stored) => adoptDeleted(stored, resolvedTaskId));
          onTaskDeleted(resolvedTaskId);
          onTasksStored?.(outcome.tasks);
        }

        processed += 1;
      }
    } catch (error) {
      if (isSessionChangedError(error)) {
        // The account or token changed between building this request and sending it, and the API client
        // refused to send it. Nothing was sent. Keep this entry and everything not yet attempted for the
        // owner; do not retry under whoever is signed in now.
        blocked = 'auth';
        break;
      }

      if (isAuthError(error)) {
        // Stop here. The response interceptor has already signed the user out, so every further
        // request would go out without credentials, fail the same way, and (before this) be thrown
        // away one by one. Keep this entry and everything not yet attempted, in order, for the next
        // run after the user signs in again.
        blocked = 'auth';
        break;
      }

      if (error instanceof TaskConflictError && entry.type === 'update' && entry.taskId) {
        // Another device changed a field this edit was based on (Issue #62B). Nothing was written on the server. The entry is dropped
        // (what to do is the person's decision, D8), what the user asked for is kept in the notice, and the server's current task is
        // adopted like any other answer: through the transaction that decides staleness, so a newer local edit is never overwritten.
        const resolvedTaskId = idMap.get(entry.taskId) ?? entry.taskId;
        conflicts.push({ taskId: resolvedTaskId, title: titleOfEntry(entry), fields: error.conflicts, mine: { ...(entry.payload ?? {}) }, base: { ...(entry.base ?? {}) } });
        settled.set(entry.id, { outcome: 'conflicted', payload: entry.payload, serverTaskId: resolvedTaskId });
        const serverTask = error.task;
        // like an applied answer: a completion waiting behind this edit means the local copy is ahead, and that completion's answer is adopted instead
        const completionWaits = queue.slice(index + 1).some((item) => item.type === 'completion' && item.taskId === entry.taskId);
        if (serverTask && !completionWaits && stillSignedIn()) {
          const outcome = await adopt([entry.taskId, resolvedTaskId], (stored, { stale }) => adoptUpdated(stored, resolvedTaskId, serverTask, stale));
          if (!outcome.stale) onTaskUpdated(resolvedTaskId, serverTask, { stale: false });
          onTasksStored?.(outcome.tasks);
        }
        processed += 1;
        continue;
      }

      if (isPermanentError(error)) {
        console.warn('[syncQueue] Discarding permanently failed entry:', entry.type, entry.taskId, error);
        rejected.push({ type: entry.type, taskId: entry.taskId ?? null, title: titleOfEntry(entry), status: httpStatusOf(error) });
        settled.set(entry.id, { outcome: 'discarded' });
        processed += 1;
        continue;
      }
      // any other failure: not settled, so the entry stays queued for the next run. An auth stop already recorded stays
      // the reason (the run ended there); otherwise the server may not have received this work.
      blocked ??= 'unreachable';
    }
  }

  const settledState = await settleSyncQueueAndTasks(ownerId, settled, sentCreates, idMap);
  const remaining = settledState.queue.length;
  // The list as the settle stored it: every task's pending flag now matches the queue that was just written (Issue #61).
  if (settledState.tasks && stillSignedIn()) onTasksStored?.(settledState.tasks);
  if (deliveredCompletions > 0 && stillSignedIn()) onCompletionsDelivered?.();

  return {
    processed,
    failed: remaining,
    remaining,
    rejected,
    conflicts,
    blocked,
  };
};

// ─── One sync run at a time, per account ────────────────────────────────────────────────────────────────────────────────
// Two runs that overlap would both read the same queue and both send the same create (the settle step protects the LOCAL
// queue, it cannot take back a request that was already sent). So runs are serialized: a second caller waits for the one
// in progress and then runs against the settled queue, so it only sends what is still queued. Across browser tabs the
// same is done with a Web Lock named after the account, where the browser has them; without Web Locks (older browsers,
// tests) only runs inside one page are serialized. A run is bounded by the API client's request timeout, so a hung
// request cannot hold the lock forever.
const runningFor = new Map<string, Promise<unknown>>();

const withCrossTabLock = <T>(ownerId: string, fn: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? (navigator as Navigator & { locks?: LockManager }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks.request(`halotasks-sync:${ownerId}`, fn) : fn();
};

export const processSyncQueue = (params: ProcessSyncQueueParams): Promise<ProcessSyncQueueResult> => {
  const ownerId = captureSession()?.userId;
  if (!ownerId) return Promise.resolve({ processed: 0, failed: 0, remaining: 0, rejected: [], conflicts: [], blocked: null });

  const previous = runningFor.get(ownerId) ?? Promise.resolve();
  const run = previous.then(() => withCrossTabLock(ownerId, () => runSyncQueue(params)));
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  runningFor.set(ownerId, tail);
  void tail.then(() => {
    if (runningFor.get(ownerId) === tail) runningFor.delete(ownerId);
  });
  return run;
};
