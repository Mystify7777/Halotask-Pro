import { offlineDb } from './db';

export type SyncQueueActionType = 'create' | 'update' | 'delete';

type QueuePayload = Record<string, unknown>;

export type SyncQueueRecord = {
  id: string;
  type: SyncQueueActionType;
  taskId?: string;
  payload?: QueuePayload;
  createdAt: number;
};

const SYNC_QUEUE_KEY = 'sync_queue';

const getId = () => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
};

export const getSyncQueue = async (): Promise<SyncQueueRecord[]> => {
  return (await offlineDb.get<SyncQueueRecord[]>(SYNC_QUEUE_KEY)) ?? [];
};

export const setSyncQueue = async (queue: SyncQueueRecord[]): Promise<void> => {
  await offlineDb.set(SYNC_QUEUE_KEY, queue);
};

export const clearSyncQueue = async (): Promise<void> => {
  await setSyncQueue([]);
};

export const enqueueSyncAction = async (
  action: Omit<SyncQueueRecord, 'id' | 'createdAt'>,
): Promise<SyncQueueRecord[]> => {
  const queue = await getSyncQueue();

  const nextAction: SyncQueueRecord = {
    ...action,
    id: getId(),
    createdAt: Date.now(),
  };

  if (nextAction.type === 'update' && nextAction.taskId) {
    const createIndex = queue.findIndex((item) => item.type === 'create' && item.taskId === nextAction.taskId);
    if (createIndex >= 0) {
      const createEntry = queue[createIndex];
      queue[createIndex] = {
        ...createEntry,
        payload: {
          ...(createEntry.payload ?? {}),
          ...(nextAction.payload ?? {}),
        },
        createdAt: nextAction.createdAt,
      };

      await setSyncQueue(queue);
      return queue;
    }

    const updateIndex = queue.findIndex((item) => item.type === 'update' && item.taskId === nextAction.taskId);
    if (updateIndex >= 0) {
      const updateEntry = queue[updateIndex];
      queue[updateIndex] = {
        ...updateEntry,
        payload: {
          ...(updateEntry.payload ?? {}),
          ...(nextAction.payload ?? {}),
        },
        createdAt: nextAction.createdAt,
      };

      await setSyncQueue(queue);
      return queue;
    }
  }

  if (nextAction.type === 'delete' && nextAction.taskId) {
    const withoutRelatedUpdates = queue.filter((item) => !(item.type === 'update' && item.taskId === nextAction.taskId));

    const createIndex = withoutRelatedUpdates.findIndex(
      (item) => item.type === 'create' && item.taskId === nextAction.taskId,
    );

    if (createIndex >= 0) {
      withoutRelatedUpdates.splice(createIndex, 1);
      await setSyncQueue(withoutRelatedUpdates);
      return withoutRelatedUpdates;
    }

    const hasDeleteAlready = withoutRelatedUpdates.some(
      (item) => item.type === 'delete' && item.taskId === nextAction.taskId,
    );

    if (hasDeleteAlready) {
      await setSyncQueue(withoutRelatedUpdates);
      return withoutRelatedUpdates;
    }

    const nextQueue = [...withoutRelatedUpdates, nextAction];
    await setSyncQueue(nextQueue);
    return nextQueue;
  }

  const nextQueue = [...queue, nextAction];
  await setSyncQueue(nextQueue);
  return nextQueue;
};
