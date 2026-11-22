import { offlineDb } from './db';
import { useAuthStore } from '../store/authStore';
import { applyActionToQueue, newMutationId, newQueueId, type QueueActionInput } from './queueActions';
import { resetStoreLock, TASKS_KEY, withStoreLock } from './storeLock';
import { derivePending } from './taskReconcile';
import type { Task } from '../types/task';

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
  /**
   * The id the entry's CURRENT payload is sent under (Issue #60; see newMutationId). Assigned when the entry is queued and
   * replaced whenever its payload changes. Absent only on entries queued before it existed: the processor gives those one
   * (and stores it) before sending anything.
   */
  mutationId?: string;
};

// One queue PER ACCOUNT: `sync_queue:<userId>`. Isolation is by construction — there is no way to read
// or write a queue without naming whose it is, so one account's queued actions can never be sent under
// another account's credentials (requests carry whatever token is current).
const SYNC_QUEUE_KEY_PREFIX = 'sync_queue:';

// Before per-account queues everything lived under this single key with no record of who queued what.
// Its owner cannot be proven (a different account may have signed in since), so it is never read, sent
// or handed to whoever logs in next; it is removed once. Same rule as history (Issue #31).
const LEGACY_SYNC_QUEUE_KEY = 'sync_queue';

export const queueKeyFor = (userId: string): string => `${SYNC_QUEUE_KEY_PREFIX}${userId}`;
const keyFor = queueKeyFor;

const withQueueLock = withStoreLock;

/** The account whose queue the app is operating on right now; null when nobody is signed in. */
export const getCurrentQueueOwner = (): string | null => useAuthStore.getState().user?.id || null;

let legacyPurged = false;
export const purgeLegacySyncQueueOnce = async (): Promise<void> => {
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
export const settleSyncQueue = async (
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
): Promise<SyncQueueRecord[]> => (await settleSyncQueueAndTasks(ownerId, settled, sentCreates, idMap)).queue;

/**
 * `settleSyncQueue`, also returning the task list as stored. The queue AND the task list are read and written in ONE transaction:
 * every task's `pendingSync` is derived from the queue this very write produces (Issue #61, I4), so the flag cannot disagree with
 * the queue a moment after the run, in either direction (a completion still waiting keeps its task pending; a suppressed stale
 * answer whose work is gone no longer leaves "Not synced yet" behind). `tasks` is null when no list is stored.
 */
export const settleSyncQueueAndTasks = async (
  ownerId: string,
  settled: Map<string, SettledEntry>,
  sentCreates: Map<string, string>,
  idMap: Map<string, string> = new Map(),
): Promise<{ queue: SyncQueueRecord[]; tasks: Task[] | null }> => {
  await purgeLegacySyncQueueOnce();
  return withQueueLock(() =>
    offlineDb.transaction(async (tx) => {
      const current = (await tx.get<SyncQueueRecord[]>(keyFor(ownerId))) ?? [];
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
        // The residual is a different change from the one that was sent (and from the entry as it was queued): its own mutation id.
        next.push({ ...entry, type: 'update', taskId: result.serverTaskId, payload: delta, mutationId: newMutationId() });
      }

      for (const [entryId, serverTaskId] of sentCreates) {
        if (!stillQueued.has(entryId)) {
          next.push({ id: newQueueId(), type: 'delete', taskId: serverTaskId, createdAt: Date.now(), mutationId: newMutationId() });
        }
      }

      await tx.put(keyFor(ownerId), next);
      const stored = await tx.get<Task[]>(TASKS_KEY);
      const tasks = stored ? derivePending(stored, next) : null;
      if (tasks) await tx.put(TASKS_KEY, tasks);
      return { queue: next, tasks };
    }),
  );
};

/**
 * Gives every entry that has no mutation id one, and STORES them, before anything is sent (Issue #60): an id that was only
 * ever in memory could differ on the next run, and a retry must reuse the id the earlier attempt went out under. Entries
 * that already have one are left exactly as they are. Runs under the queue lock, so it cannot race an edit merging in.
 */
export const ensureMutationIds = (ownerId: string): Promise<SyncQueueRecord[]> =>
  withQueueLock(async () => {
    const current = await getSyncQueue(ownerId);
    if (current.every((entry) => entry.mutationId)) return current;
    const next = current.map((entry) => (entry.mutationId ? entry : { ...entry, mutationId: newMutationId() }));
    await setSyncQueue(next, ownerId);
    return next;
  });

/** resetSyncQueueState — for testing only. */
export const resetSyncQueueState = (): void => {
  legacyPurged = false;
  resetStoreLock();
};

export const enqueueSyncAction = (action: QueueActionInput): Promise<SyncQueueRecord[]> => {
  // The action belongs to whoever is signed in when it is made — not to whoever is signed in by the
  // time the lock frees up.
  const ownerId = getCurrentQueueOwner();
  if (!ownerId) {
    return Promise.reject(new Error('Cannot queue a sync action without a signed-in account'));
  }

  return withQueueLock(async () => {
    const queue = await getSyncQueue(ownerId);
    const nextQueue = applyActionToQueue(queue, action);
    await setSyncQueue(nextQueue, ownerId);
    return nextQueue;
  });
};
