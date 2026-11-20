import type { SyncQueueRecord } from './syncQueue';

/** What a caller asks to queue: everything but the id and the time, which the queue assigns. */
export type QueueActionInput = Omit<SyncQueueRecord, 'id' | 'createdAt'>;

type QueuePayload = Record<string, unknown>;

export const newQueueId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

/** Identity of a completion entry for de-duplication: `kind:completionId`. null when it names no completion (an id-less revoke). */
export const completionKeyOf = (entry: { payload?: QueuePayload }): string | null => {
  const kind = entry.payload?.kind;
  const id = entry.payload?.completionId;
  return typeof kind === 'string' && typeof id === 'string' ? `${kind}:${id}` : null;
};

/**
 * THE QUEUE CONTRACT (Issue #59). `applyActionToQueue` is the only place entries are coalesced. Every rule below is pinned
 * by `queueActions.contract.test.ts`; the audit behind it is claude/audit-issue-59.md.
 *
 *  1. Coalescing is per task and only for plain field edits: an update merges into the task's queued create, else its queued
 *     update, last value winning per field. Nothing else is merged.
 *  2. A completion entry is an EVENT (identity: `kind:completionId`), not a field value. It is never merged, never reordered,
 *     never cancelled by another completion (complete -> revoke -> complete stays three events), never dropped by a delete
 *     (create -> complete -> delete leaves the completion), and is de-duplicated only by its exact id (the same event queued
 *     twice).
 *  3. A delete drops the task's queued updates, cancels a queued create entirely, and is queued once. Nothing may be queued
 *     behind it for the same task: an update for a task with a queued delete is dropped (it could only reach a task that is
 *     gone and come back as a permanent 404).
 *  4. Order: an entry keeps its position or is removed; new work goes to the end; per-task order is preserved, across tasks
 *     entries stay in the order each task was FIRST queued.
 *  5. An edit may merge ACROSS a completion entry of the same task (update, complete, update -> update, complete) ONLY while
 *     its payload cannot modify completion state. A payload that names any completion field (`COMPLETION_STATE_FIELDS`) is
 *     never merged backwards over a completion: it is appended after it, so it cannot move a state change across the event.
 *  6. Identity survives: a merge keeps the entry's `id`, `type` and `taskId` (only the payload and `createdAt` change); a
 *     completion entry's payload (and its `completionId`) is never rewritten.
 *  7. All of this happens at insertion, inside the commit transaction, never during a sync run (the processor and
 *     `settleSyncQueue` rely on entries changing only by that merge). #60's batching takes the coalesced queue, in order and
 *     with ids intact, as its input; coalescing never depends on batching.
 */

/**
 * Update-payload fields that change a task's completion state. No writer puts them in an update today (completion goes
 * through its own entry type), which is exactly why merging an edit across a completion is safe. Rule 5 makes that reason
 * explicit instead of an accident of the current payloads.
 */
export const COMPLETION_STATE_FIELDS = ['completed', 'completedAt', 'completionId', 'completionEvent'] as const;

const touchesCompletionState = (payload: QueuePayload | undefined): boolean =>
  payload !== undefined && COMPLETION_STATE_FIELDS.some((field) => field in payload);

/**
 * The queue after `action` is added to it. Pure: it returns a new array and never touches storage. This is the merge
 * policy the queue has always had (moved here in Issue #57, with the Issue #59 guards below) so the same rules apply whether an action is queued on its own
 * (`enqueueSyncAction`) or together with the task list (`commitLocalMutation`, Issue #57):
 *  - a completion entry is idempotent by `kind:completionId`, is never merged into another entry and nothing merges into it;
 *  - an update merges into the task's queued create, else into its queued update (later fields win), else is appended;
 *  - a delete drops the task's queued updates, cancels a queued create entirely (the task never reached the server), or is
 *    appended once; completion entries are never dropped by a delete. An update for a task with a queued delete is dropped;
 *  - an edit merges across a completion only while it cannot touch completion state (see THE QUEUE CONTRACT above).
 * Order is preserved: entries only ever keep their position or are removed, and a new entry goes to the end.
 */
export const applyActionToQueue = (
  queue: readonly SyncQueueRecord[],
  action: QueueActionInput,
  id: string = newQueueId(),
  now: number = Date.now(),
): SyncQueueRecord[] => {
  const next: SyncQueueRecord = { ...action, id, createdAt: now };
  const items = [...queue];

  if (next.type === 'completion') {
    const key = completionKeyOf(next);
    if (key !== null && items.some((item) => item.type === 'completion' && completionKeyOf(item) === key)) {
      return items;
    }
    return [...items, next];
  }

  if (next.type === 'update' && next.taskId) {
    // Rule 3: nothing is queued behind a delete of the same task.
    if (items.some((item) => item.type === 'delete' && item.taskId === next.taskId)) return items;

    // Rule 5: an edit that could change completion state never merges backwards over a completion of the same task.
    const lastCompletionIndex = items.reduce(
      (last, item, index) => (item.type === 'completion' && item.taskId === next.taskId ? index : last),
      -1,
    );
    const mayMerge = (index: number) => !(touchesCompletionState(next.payload) && index < lastCompletionIndex);

    const mergeInto = (index: number) => {
      items[index] = {
        ...items[index],
        payload: { ...(items[index].payload ?? {}), ...(next.payload ?? {}) },
        createdAt: next.createdAt,
      };
      return items;
    };

    const createIndex = items.findIndex((item, index) => item.type === 'create' && item.taskId === next.taskId && mayMerge(index));
    if (createIndex >= 0) return mergeInto(createIndex);

    const updateIndex = items.findIndex((item, index) => item.type === 'update' && item.taskId === next.taskId && mayMerge(index));
    if (updateIndex >= 0) return mergeInto(updateIndex);
  }

  if (next.type === 'delete' && next.taskId) {
    const withoutRelatedUpdates = items.filter((item) => !(item.type === 'update' && item.taskId === next.taskId));

    const createIndex = withoutRelatedUpdates.findIndex((item) => item.type === 'create' && item.taskId === next.taskId);
    if (createIndex >= 0) {
      withoutRelatedUpdates.splice(createIndex, 1);
      return withoutRelatedUpdates;
    }

    if (withoutRelatedUpdates.some((item) => item.type === 'delete' && item.taskId === next.taskId)) {
      return withoutRelatedUpdates;
    }

    return [...withoutRelatedUpdates, next];
  }

  return [...items, next];
};
