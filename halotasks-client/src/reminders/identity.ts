import type { Task } from '../types/task';

/**
 * The identity a task's reminders are keyed on (the scheduler's in-session key and the notification tag).
 *
 * A task created offline starts life as `local-…` and later receives the server's `_id`. If reminders were keyed on
 * `_id` alone, the id change would look like a different task and re-arm a reminder that already fired. `clientKey`
 * remembers the first id, so the logical task keeps one identity across that reconciliation. Tasks that were never
 * local fall back to `_id`, which keeps every existing key and tag exactly as it was.
 */
export const reminderIdentity = (task: Pick<Task, '_id' | 'clientKey'>): string => task.clientKey ?? task._id;

/**
 * Returns `serverTask` with the identity of the local task it replaces. Pass the local task (or the previous copy of an
 * already-synced task) and, for a create, the local id the queue was holding.
 */
export const keepReminderIdentity = (serverTask: Task, previous?: Pick<Task, '_id' | 'clientKey'>, localId?: string): Task => {
  const key = previous?.clientKey ?? (localId && localId !== serverTask._id ? localId : undefined);
  return key && key !== serverTask._id ? { ...serverTask, clientKey: key } : serverTask;
};
