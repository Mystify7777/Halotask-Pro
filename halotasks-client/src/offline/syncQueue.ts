import { offlineDb } from './db';
import { useAuthStore } from '../store/authStore';

/**
 * `completion` (Issue #47, Phase 2E) is one completion event: the user completed or re-opened a task. It is its own entry
 * type because a completion is an EVENT, not a field value: the plain-update rule ("the last write wins") would turn
 * complete, un-complete, complete into one write and the server would never see the transitions. Rules, all below:
 *  - a completion entry is never merged into another entry, and nothing merges into it;
 *  - a delete of the task drops only plain updates, never a completion entry (the completion really happened and the
 *    history must keep it even if the task is gone before delivery);
 *  - queuing the same event twice (same kind, same completionId) stores it once.
 */
export type SyncQueueActionType = 'create' | 'update' | 'delete' | 'completion';

type QueuePayload = Record<string, unknown>;

export type SyncQueueRecord = {
  id: string;
  type: SyncQueueActionType;
  taskId?: string;
  payload?: QueuePayload;
  createdAt: number;
};

// One queue PER ACCOUNT: `sync_queue:<userId>`. Isolation is by construction — there is no way to read
// or write a queue without naming whose it is, so one account's queued actions can never be sent under
// another account's credentials (requests carry whatever token is current).
const SYNC_QUEUE_KEY_PREFIX = 'sync_queue:';

// Before per-account queues everything lived under this single key with no record of who queued what.
// Its owner cannot be proven (a different account may have signed in since), so it is never read, sent
// or handed to whoever logs in next; it is removed once. Same rule as history (Issue #31).
const LEGACY_SYNC_QUEUE_KEY = 'sync_queue';

const keyFor = (userId: string): string => `${SYNC_QUEUE_KEY_PREFIX}${userId}`;

const getId = () =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

let operationChain: Promise<unknown> = Promise.resolve();

function withQueueLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = operationChain.then(fn);
  operationChain = result.catch(() => {});
  return result;
}

/** The account whose queue the app is operating on right now; null when nobody is signed in. */
export const getCurrentQueueOwner = (): string | null => useAuthStore.getState().user?.id || null;

let legacyPurged = false;
const purgeLegacySyncQueueOnce = async (): Promise<void> => {
  if (legacyPurged) return;
  legacyPurged = true;
  try {
    const legacy = await offlineDb.get<unknown[]>(LEGACY_SYNC_QUEUE_KEY);
    if (legacy === null) return;
    await offlineDb.remove(LEGACY_SYNC_QUEUE_KEY);
    if (Array.isArray(legacy) && legacy.length > 0) {
      console.warn(
        `[syncQueue] Discarded ${legacy.length} queued action(s) from before per-account queues: ` +
          'their owner cannot be determined, so they are never sent.',
      );
    }
  } catch (err) {
    legacyPurged = false;
    console.warn('[syncQueue] Could not remove the legacy unscoped queue:', err);
  }
};

/** Pass the owner explicitly whenever work spans an await: the signed-in account can change meanwhile. */
export const getSyncQueue = async (
  userId: string | null = getCurrentQueueOwner(),
): Promise<SyncQueueRecord[]> => {
  await purgeLegacySyncQueueOnce();
  if (!userId) return [];
  return (await offlineDb.get<SyncQueueRecord[]>(keyFor(userId))) ?? [];
};

export const setSyncQueue = async (
  queue: SyncQueueRecord[],
  userId: string | null = getCurrentQueueOwner(),
): Promise<void> => {
  if (!userId) throw new Error('Cannot write a sync queue without an owning account');
  await offlineDb.set(keyFor(userId), queue);
};

export const clearSyncQueue = async (userId: string | null = getCurrentQueueOwner()): Promise<void> =>
  setSyncQueue([], userId);

/** What the processor did with one queue entry during a run (see settleSyncQueue). */
export type SettledEntry =
  /** Sent and accepted. `payload` is exactly what was read when the run started; `serverTaskId` is the task it landed on. */
  | { outcome: 'sent'; payload: QueuePayload | undefined; serverTaskId: string | null }
  /** Permanently refused by the server: dropped, never retried (the pre-existing rule for 4xx answers). */
  | { outcome: 'discarded' };

/** Identity of a completion entry for de-duplication: `kind:completionId`. null when it names no completion (an id-less revoke). */
const completionKeyOf = (entry: { payload?: QueuePayload }): string | null => {
  const kind = entry.payload?.kind;
  const id = entry.payload?.completionId;
  return typeof kind === 'string' && typeof id === 'string' ? `${kind}:${id}` : null;
};

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** The fields of `current` that `sent` did not carry (or carried with another value). */
const changedSince = (sent: QueuePayload | undefined, current: QueuePayload | undefined): QueuePayload => {
  const delta: QueuePayload = {};
  for (const [key, value] of Object.entries(current ?? {})) {
    if (!sent || !(key in sent) || !sameValue(sent[key], value)) delta[key] = value;
  }
  return delta;
};

/**
 * Writes the outcome of a processor run back to the queue WITHOUT overwriting what happened while it ran. The run reads
 * the queue, then waits on the network entry by entry; in that time the user can queue more edits (a new entry, or a merge
 * into an entry that is already in flight). So the queue is re-read here, under the same lock as enqueueSyncAction, and:
 *  - an entry the run did not finish stays exactly as it is NOW (including edits merged into it meanwhile);
 *  - a finished entry is dropped when nothing was merged into it after it was read, and otherwise only what was merged
 *    after is kept, as an update to the task the entry landed on, so the late edit is not lost and not sent twice;
 *  - a discarded entry is dropped;
 *  - a create that was sent but is no longer queued was deleted while it was in flight: the task now exists on the server,
 *    so a delete for it is queued instead of leaving it behind.
 * Returns the queue as written.
 */
export const settleSyncQueue = (
  ownerId: string,
  settled: Map<string, SettledEntry>,
  sentCreates: Map<string, string>,
  /**
   * local id -> server id of the creates this run sent. A completion entry still waiting (queued while its create was in flight,
   * or not reached because the run stopped) names the task by its local id, and that id means nothing to the next run, which
   * has no record of the remap: it is rewritten to the server id here. Only completion entries are rewritten; every other kind
   * is merged into its create or handled above, as before.
   */
  idMap: Map<string, string> = new Map(),
): Promise<SyncQueueRecord[]> =>
  withQueueLock(async () => {
    const current = await getSyncQueue(ownerId);
    const next: SyncQueueRecord[] = [];
    const stillQueued = new Set(current.map((entry) => entry.id));

    for (const entry of current) {
      const result = settled.get(entry.id);
      if (!result) {
        const remapped = entry.type === 'completion' && entry.taskId ? idMap.get(entry.taskId) : undefined;
        next.push(remapped ? { ...entry, taskId: remapped } : entry);
        continue;
      }
      if (result.outcome === 'discarded') continue;

      const delta = changedSince(result.payload, entry.payload);
      if (Object.keys(delta).length === 0 || !result.serverTaskId) continue;
      next.push({ ...entry, type: 'update', taskId: result.serverTaskId, payload: delta });
    }

    for (const [entryId, serverTaskId] of sentCreates) {
      if (!stillQueued.has(entryId)) {
        next.push({ id: getId(), type: 'delete', taskId: serverTaskId, createdAt: Date.now() });
      }
    }

    await setSyncQueue(next, ownerId);
    return next;
  });

/** resetSyncQueueState — for testing only. */
export const resetSyncQueueState = (): void => {
  legacyPurged = false;
  operationChain = Promise.resolve();
};

export const enqueueSyncAction = (
  action: Omit<SyncQueueRecord, 'id' | 'createdAt'>,
): Promise<SyncQueueRecord[]> => {
  // The action belongs to whoever is signed in when it is made — not to whoever is signed in by the
  // time the lock frees up.
  const ownerId = getCurrentQueueOwner();
  if (!ownerId) {
    return Promise.reject(new Error('Cannot queue a sync action without a signed-in account'));
  }

  return withQueueLock(async () => {
    const queue = await getSyncQueue(ownerId);

    const nextAction: SyncQueueRecord = {
      ...action,
      id: getId(),
      createdAt: Date.now(),
    };

    if (nextAction.type === 'completion') {
      // Idempotent enqueue: the same event (kind + completionId) is stored once, wherever it already is in the queue.
      const key = completionKeyOf(nextAction);
      if (key !== null && queue.some((item) => item.type === 'completion' && completionKeyOf(item) === key)) {
        return queue;
      }
      const nextQueue = [...queue, nextAction];
      await setSyncQueue(nextQueue, ownerId);
      return nextQueue;
    }

    if (nextAction.type === 'update' && nextAction.taskId) {
      const createIndex = queue.findIndex((item) => item.type === 'create' && item.taskId === nextAction.taskId);
      if (createIndex >= 0) {
        queue[createIndex] = {
          ...queue[createIndex],
          payload: {
            ...(queue[createIndex].payload ?? {}),
            ...(nextAction.payload ?? {}),
          },
          createdAt: nextAction.createdAt,
        };

        await setSyncQueue(queue, ownerId);
        return queue;
      }

      const updateIndex = queue.findIndex((item) => item.type === 'update' && item.taskId === nextAction.taskId);
      if (updateIndex >= 0) {
        queue[updateIndex] = {
          ...queue[updateIndex],
          payload: {
            ...(queue[updateIndex].payload ?? {}),
            ...(nextAction.payload ?? {}),
          },
          createdAt: nextAction.createdAt,
        };

        await setSyncQueue(queue, ownerId);
        return queue;
      }
    }

    if (nextAction.type === 'delete' && nextAction.taskId) {
      const withoutRelatedUpdates = queue.filter(
        (item) => !(item.type === 'update' && item.taskId === nextAction.taskId),
      );

      const createIndex = withoutRelatedUpdates.findIndex(
        (item) => item.type === 'create' && item.taskId === nextAction.taskId,
      );

      if (createIndex >= 0) {
        withoutRelatedUpdates.splice(createIndex, 1);
        await setSyncQueue(withoutRelatedUpdates, ownerId);
        return withoutRelatedUpdates;
      }

      const hasDeleteAlready = withoutRelatedUpdates.some(
        (item) => item.type === 'delete' && item.taskId === nextAction.taskId,
      );

      if (hasDeleteAlready) {
        await setSyncQueue(withoutRelatedUpdates, ownerId);
        return withoutRelatedUpdates;
      }

      const nextQueue = [...withoutRelatedUpdates, nextAction];
      await setSyncQueue(nextQueue, ownerId);
      return nextQueue;
    }

    const nextQueue = [...queue, nextAction];
    await setSyncQueue(nextQueue, ownerId);
    return nextQueue;
  });
};
