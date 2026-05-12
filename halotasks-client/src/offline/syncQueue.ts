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

export const getSyncQueue = async (): Promise<SyncQueueRecord[]> =>
  (await offlineDb.get<SyncQueueRecord[]>(SYNC_QUEUE_KEY)) ?? [];

export const setSyncQueue = async (queue: SyncQueueRecord[]): Promise<void> =>
  offlineDb.set(SYNC_QUEUE_KEY, queue);

export const clearSyncQueue = async (): Promise<void> => setSyncQueue([]);

export const enqueueSyncAction = (
  action: Omit<SyncQueueRecord, 'id' | 'createdAt'>,
): Promise<SyncQueueRecord[]> =>
  withQueueLock(async () => {
    const queue = await getSyncQueue();

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

        await setSyncQueue(queue);
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

        await setSyncQueue(queue);
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
  });
