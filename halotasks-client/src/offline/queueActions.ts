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
 * The queue after `action` is added to it. Pure: it returns a new array and never touches storage. This is the merge
 * policy the queue has always had, moved here unchanged so the same rules apply whether an action is queued on its own
 * (`enqueueSyncAction`) or together with the task list (`commitLocalMutation`, Issue #57):
 *  - a completion entry is idempotent by `kind:completionId`, is never merged into another entry and nothing merges into it;
 *  - an update merges into the task's queued create, else into its queued update (later fields win), else is appended;
 *  - a delete drops the task's queued updates, cancels a queued create entirely (the task never reached the server), or is
 *    appended once; completion entries are never dropped by a delete.
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
    const mergeInto = (index: number) => {
      items[index] = {
        ...items[index],
        payload: { ...(items[index].payload ?? {}), ...(next.payload ?? {}) },
        createdAt: next.createdAt,
      };
      return items;
    };

    const createIndex = items.findIndex((item) => item.type === 'create' && item.taskId === next.taskId);
    if (createIndex >= 0) return mergeInto(createIndex);

    const updateIndex = items.findIndex((item) => item.type === 'update' && item.taskId === next.taskId);
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
