import { offlineDb } from './db';
import { useAuthStore } from '../store/authStore';

export type SyncQueueActionType = 'create' | 'update' | 'delete';

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
