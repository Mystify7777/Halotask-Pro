import type { Task } from '../types/task';
import { offlineDb } from './db';
import { applyActionToQueue, type QueueActionInput } from './queueActions';
import { getCurrentQueueOwner, purgeLegacySyncQueueOnce, queueKeyFor, type SyncQueueRecord } from './syncQueue';
import { TASKS_KEY, withStoreLock } from './storeLock';
import { derivePending, isOlderSnapshot, withRevision } from './taskReconcile';

export { derivePending } from './taskReconcile';

/**
 * Local-first task mutations (Issue #57).
 *
 * `commitLocalMutation` is the single way a user's task mutation reaches storage: the new task list AND the queue entries
 * that will carry the mutation to the server are written in ONE IndexedDB transaction. Either both are stored or neither
 * is, so after a crash or a reload the list and the queue always agree: there is never a visible change without its queue
 * entry, nor a queue entry for a change the list does not show. A caller renders only after this resolves.
 *
 * Both the list and the queue are read INSIDE that transaction and `derive` works on what was read. Two mutations committed
 * in quick succession (from separate calls, or from two tabs) therefore run one after the other, each on the result of the
 * one before; neither can start from a copy the other has replaced. Entries keep the order the commits happened in (the
 * queue's merge policy is `applyActionToQueue`, unchanged).
 */

export type LocalMutation = {
  /**
   * Pure. Runs inside the transaction on the STORED list and returns the next list and the queue actions for it. Throw a
   * MutationRejectedError to refuse the mutation: nothing is written.
   */
  derive: (stored: Task[]) => { tasks: Task[]; actions: QueueActionInput[] };
  /** The list to start from only when no list has been stored yet (a first run, before any load has cached one). */
  seed?: Task[];
};

export type CommitResult = { tasks: Task[]; queue: SyncQueueRecord[] };

export const commitLocalMutation = (mutation: LocalMutation): Promise<CommitResult> => {
  // The mutation belongs to whoever is signed in when it is made, not to whoever is signed in when the lock frees up.
  const ownerId = getCurrentQueueOwner();
  if (!ownerId) return Promise.reject(new Error('Cannot commit a change without a signed-in account'));

  return withStoreLock(async () => {
    await purgeLegacySyncQueueOnce();
    return offlineDb.transaction(async (tx) => {
      const stored = (await tx.get<Task[]>(TASKS_KEY)) ?? mutation.seed ?? [];
      const queue = (await tx.get<SyncQueueRecord[]>(queueKeyFor(ownerId))) ?? [];
      const { tasks, actions } = mutation.derive(stored);
      const nextQueue = actions.reduce<SyncQueueRecord[]>((current, action) => applyActionToQueue(current, action), queue);
      await tx.put(TASKS_KEY, tasks);
      await tx.put(queueKeyFor(ownerId), nextQueue);
      return { tasks, queue: nextQueue };
    });
  });
};

/**
 * Stores a task list read from the server WITHOUT losing local work that has not been sent yet. The server's copy of a
 * task that still has queued work is older than the local one, so the local copy is kept; a task with a queued delete
 * stays gone; a task created locally whose create is still queued is kept. Everything else is the server's version.
 * Reads the stored list and the queue inside the transaction that replaces the list.
 */
export const reconcileServerTasks = (
  fresh: Task[],
  adopt: (serverTask: Task, localTask: Task | undefined) => Task = (serverTask) => serverTask,
  ownerId: string | null = getCurrentQueueOwner(),
): Promise<Task[]> =>
  withStoreLock(() =>
    offlineDb.transaction(async (tx) => {
      const stored = (await tx.get<Task[]>(TASKS_KEY)) ?? [];
      const queue = ownerId ? ((await tx.get<SyncQueueRecord[]>(queueKeyFor(ownerId))) ?? []) : [];

      const queuedIds = new Set(queue.flatMap((entry) => (entry.taskId ? [entry.taskId] : [])));
      const deletedIds = new Set(queue.filter((entry) => entry.type === 'delete').flatMap((entry) => (entry.taskId ? [entry.taskId] : [])));
      const localById = new Map(stored.map((task) => [task._id, task]));

      const next: Task[] = [];
      const seen = new Set<string>();
      for (const serverTask of fresh) {
        if (deletedIds.has(serverTask._id)) continue;
        const local = localById.get(serverTask._id);
        // Queued work keeps the local copy (I1). So does a snapshot OLDER than the one this copy was adopted from (I3): a list
        // answered before an acknowledgement that was adopted meanwhile must not put the acknowledged state back.
        const keepLocal = local && (queuedIds.has(serverTask._id) || isOlderSnapshot(serverTask, local));
        next.push(keepLocal ? local : { ...withRevision(adopt(serverTask, local)), pendingSync: false });
        seen.add(serverTask._id);
      }
      // Created here, not yet on the server: only the queue's create entries say so.
      for (const entry of queue) {
        if (entry.type === 'create' && entry.taskId && !seen.has(entry.taskId)) {
          const local = localById.get(entry.taskId);
          if (local) next.unshift(local);
        }
      }

      // Pending work for a task the server's list does not contain (the response was partial, cut off, or the task is new
      // to this device): the server omitting it is not evidence it is gone. It keeps its local copy until its queued work
      // is delivered or refused; only a queued delete removes it.
      for (const local of stored) {
        if (!seen.has(local._id) && queuedIds.has(local._id) && !deletedIds.has(local._id) && !next.some((task) => task._id === local._id)) {
          next.push(local);
        }
      }

      const derived = derivePending(next, queue);
      await tx.put(TASKS_KEY, derived);
      return derived;
    }),
  );

/**
 * After a sync run the server refused part of the queue for good (Issue #57), those entries are gone from the queue and
 * must not keep showing as "pending". Inside one transaction: a task without any queued entry is no longer pending, and a
 * task that only ever existed here (a `local-` id with no queued create) is dropped, since its create was refused.
 * Works from the queue as it is NOW, so work queued meanwhile keeps its tasks pending.
 */
export const settleRejectedLocalState = (ownerId: string | null = getCurrentQueueOwner()): Promise<Task[]> =>
  withStoreLock(() =>
    offlineDb.transaction(async (tx) => {
      const stored = (await tx.get<Task[]>(TASKS_KEY)) ?? [];
      const queue = ownerId ? ((await tx.get<SyncQueueRecord[]>(queueKeyFor(ownerId))) ?? []) : [];
      const queuedIds = new Set(queue.flatMap((entry) => (entry.taskId ? [entry.taskId] : [])));
      const next = derivePending(
        stored.filter((task) => queuedIds.has(task._id) || !task._id.startsWith('local-')),
        queue,
      );
      await tx.put(TASKS_KEY, next);
      return next;
    }),
  );

/**
 * What `adoptServerAnswer` needs to know. The processor supplies facts; the DECISION (is the answer stale?) is made inside the
 * transaction, from the queue as it is at the moment the list is written, so no edit can commit between the check and the write
 * (Issue #61, F1).
 */
export type AdoptionRequest = {
  /** The account whose queue this run works (never "whoever is signed in now"). */
  ownerId: string;
  /** Every id the task is queued under (its local id and its server id). */
  taskIds: readonly string[];
  /** The payload (JSON) of each entry as it was when the run started, by entry id. A different payload, or no entry here, is newer work. */
  snapshot: ReadonlyMap<string, string>;
  /** Treat the answer as stale regardless of the queue (a replayed create that only partly matches the entry). */
  alsoStale?: boolean;
  /** PURE and SYNCHRONOUS (see taskReconcile.ts). It runs inside the transaction: no network, callbacks, React or awaiting. */
  apply: (stored: Task[], context: { stale: boolean }) => Task[];
};

export type AdoptionResult = { tasks: Task[]; stale: boolean };

/**
 * Adopts one server answer into the stored task list. In ONE transaction under the store lock: read the list and the queue,
 * decide `stale` from that queue, apply the pure adoption, derive `pendingSync` for every task from that same queue, write the
 * list. Returns the list as stored, for the caller to show.
 */
export const adoptServerAnswer = (request: AdoptionRequest): Promise<AdoptionResult> =>
  withStoreLock(() =>
    offlineDb.transaction(async (tx) => {
      const stored = await tx.get<Task[]>(TASKS_KEY);
      const queue = (await tx.get<SyncQueueRecord[]>(queueKeyFor(request.ownerId))) ?? [];
      const stale =
        request.alsoStale === true ||
        queue.some(
          (entry) =>
            entry.taskId !== undefined && request.taskIds.includes(entry.taskId) && request.snapshot.get(entry.id) !== JSON.stringify(entry.payload ?? null),
        );
      const applied = request.apply(stored ?? [], { stale }) as unknown;
      if (!Array.isArray(applied)) throw new TypeError('adoptServerAnswer: apply must be synchronous and return the task list');
      const next = derivePending(applied as Task[], queue);
      // Nothing stored and nothing to store: do not create the key.
      if (stored || next.length > 0) await tx.put(TASKS_KEY, next);
      return { tasks: next, stale };
    }),
  );
