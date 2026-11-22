import type { Task } from '../types/task';
import { keepReminderIdentity } from '../reminders/identity';

/**
 * The PURE half of reconciling what the server said with what is stored (Issue #61). Everything here is synchronous and does no
 * storage, network or React work: the transactional callers (`adoptServerAnswer`, `reconcileServerTasks`, `settleSyncQueue`,
 * `settleRejectedLocalState`) read the task list and the queue inside ONE IndexedDB transaction, call these, and write the result
 * in that same transaction.
 *
 * Invariants these functions serve:
 *  - I1 content: a server answer never replaces a task that has queued work the answer does not cover (decided by the caller, in
 *    the transaction, and handed in as `stale`).
 *  - I2/I4 pending: `pendingSync` is a function of the queue visible in the transaction that writes the list (`derivePending`).
 *  - I3 order: a server snapshot never replaces a newer SERVER snapshot already adopted (`isOlderSnapshot`).
 */

type QueuedEntry = { id: string; taskId?: string };

/** An entry names a task by its id, or (a completion still waiting behind a create) by the local id the task was created under. */
const namesTask = (entry: QueuedEntry, task: Task): boolean =>
  entry.taskId !== undefined && (entry.taskId === task._id || (task.clientKey !== undefined && entry.taskId === task.clientKey));

/**
 * `pendingSync` from the queue, with NO exception: true exactly when a durable queue entry names the task. An entry the server has
 * just acknowledged is still a queue entry until `settleSyncQueue` removes it at the end of the run, so until then its task stays
 * pending; the settle then recomputes from the final queue. At every durable commit `pendingSync === true` iff the task has a queue
 * entry, so a crash between an adoption and the settle can never leave the cache saying "synced" while the queue says "queued".
 * Returns the same task objects for tasks whose flag is already right.
 */
export const derivePending = (tasks: Task[], queue: readonly QueuedEntry[]): Task[] => {
  return tasks.map((task) => {
    const pending = queue.some((entry) => namesTask(entry, task));
    if (pending === (task.pendingSync === true)) return task;
    return { ...task, pendingSync: pending };
  });
};

const instant = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * True when `incoming` (a server representation) is STRICTLY older than the server representation `stored` was last adopted from.
 * It compares a server `updatedAt` with a server `updatedAt` (`syncedRevision`); a local edit's own timestamp never takes part. An
 * equal timestamp is NOT older and is accepted (Issue #61, D6): `updatedAt` is used here only as a client-side ordering signal, it
 * is not a unique version, so equal timestamps are deliberately treated as equivalent. A copy without a revision (cached before
 * this existed, or never adopted from the server) protects nothing.
 */
export const isOlderSnapshot = (incoming: Pick<Task, 'updatedAt'>, stored: Pick<Task, 'syncedRevision'> | undefined): boolean => {
  const have = instant(stored?.syncedRevision);
  const got = instant(incoming.updatedAt);
  return have !== null && got !== null && got < have;
};

/**
 * The revision field is set ONLY here, from a server representation (an acknowledgement or a server list). Nothing that starts from
 * a local edit calls this.
 */
export const withRevision = (serverTask: Task): Task => (serverTask.updatedAt ? { ...serverTask, syncedRevision: serverTask.updatedAt } : serverTask);

/**
 * A queued create reached the server. Not stale: the server's task replaces the local one (with the reminder identity kept). Stale
 * (the user changed it since, and those changes are still queued): only the identity is adopted, so the queue's later entries can
 * be remapped; the content and the pending flag stay local, and the revision does NOT advance (the content shown is not that
 * revision).
 */
export const adoptCreated = (stored: Task[], localId: string, serverTask: Task, stale: boolean): Task[] =>
  stored.map((task) => {
    if (task._id !== localId) return task;
    const adopted = keepReminderIdentity(serverTask, task, localId);
    return stale ? { ...task, _id: adopted._id, clientKey: adopted.clientKey, pendingSync: true } : { ...withRevision(adopted), pendingSync: false };
  });

/** An update or completion answer. Stale: nothing changes. An answer older than the revision already adopted changes nothing either. */
export const adoptUpdated = (stored: Task[], taskId: string, serverTask: Task, stale: boolean): Task[] => {
  if (stale) return stored;
  return stored.map((task) => {
    if (task._id !== taskId || isOlderSnapshot(serverTask, task)) return task;
    return { ...withRevision(keepReminderIdentity(serverTask, task)), pendingSync: false };
  });
};

export const adoptDeleted = (stored: Task[], taskId: string): Task[] => stored.filter((task) => task._id !== taskId);
