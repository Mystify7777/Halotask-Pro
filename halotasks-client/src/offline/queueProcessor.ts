import { taskService } from '../services/taskService';
import { TaskCreatePayload, Task } from '../types/task';
import { getSyncQueue, setSyncQueue, SyncQueueRecord } from './syncQueue';

type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate'> & {
  completed?: boolean;
  dueDate?: string | null;
};

type ProcessSyncQueueParams = {
  onTaskCreated: (localTaskId: string, serverTask: Task) => void;
  onTaskUpdated: (taskId: string, serverTask: Task) => void;
  onTaskDeleted: (taskId: string) => void;
};

export type ProcessSyncQueueResult = {
  processed: number;
  failed: number;
  remaining: number;
};

export const processSyncQueue = async ({
  onTaskCreated,
  onTaskUpdated,
  onTaskDeleted,
}: ProcessSyncQueueParams): Promise<ProcessSyncQueueResult> => {
  const queue = await getSyncQueue();

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

  for (const entry of queue) {
    try {
      if (entry.type === 'create') {
        const localTaskId = entry.taskId;
        const payload = (entry.payload ?? {}) as TaskCreatePayload;
        const response = await taskService.createTask(payload);

        if (localTaskId) {
          idMap.set(localTaskId, response.task._id);
          onTaskCreated(localTaskId, response.task);
        }

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
        const response = await taskService.updateTask(resolvedTaskId, payload);
        onTaskUpdated(resolvedTaskId, response.task);

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

        await taskService.deleteTask(resolvedTaskId);
        onTaskDeleted(resolvedTaskId);

        processed += 1;
      }
    } catch {
      remainingQueue.push(entry);
    }
  }

  await setSyncQueue(remainingQueue);

  return {
    processed,
    failed: remainingQueue.length,
    remaining: remainingQueue.length,
  };
};
