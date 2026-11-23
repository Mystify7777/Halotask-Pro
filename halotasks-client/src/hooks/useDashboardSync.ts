import { useEffect, useMemo, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import { useServerRecoveries } from '../launch/launchContext';
import { looksLikeServerTrouble } from '../launch/serverTrouble';
import { getCachedTasks } from '../offline/cache';
import { reconcileServerTasks, settleRejectedLocalState } from '../offline/localMutations';
import { describeRejections } from '../offline/rejections';
import { describeConflict, type ConflictedMutation } from '../offline/conflicts';
import { processSyncQueue, type RejectedMutation } from '../offline/queueProcessor';
import { getSyncQueue } from '../offline/syncQueue';
import { announceQueueChanged, onQueueChanged } from '../offline/queueSignal';
import { deriveSyncState, type BlockedReason } from '../offline/syncState';
import { taskService } from '../services/taskService';
import type { Task } from '../types/task';
import { keepReminderIdentity } from '../reminders/identity';
import type { GrowthResult } from '../growth/treeTypes';

/**
 * A refusal the person has not dismissed yet (Issue #58), or (with `conflict`, Issue #62B) an edit the server did not apply because
 * another device changed a field first, kept until the person chooses Keep mine or Use theirs. Session memory only: nothing about
 * it is persisted (D7).
 */
export type RejectionNotice = { message: string; count: number; conflict?: ConflictedMutation };

type UseDashboardSyncArgs = {
  isOnline: boolean;
  /** Unused since Issue #61 (the processor writes the list itself, atomically); kept so callers need not change. */
  persistTasks?: (updater: (current: Task[]) => Task[]) => void;
  setLoadingTasks: (loading: boolean) => void;
  setStatusError: (message: string | null) => void;
  setStatusInfo: (message: string | null) => void;
  setTasks: (tasks: Task[]) => void;
  /**
   * Show a task list the sync run has just STORED (an adoption or the end-of-run settle). Defaults to `setTasks`; the dashboard also
   * refreshes its refs and the 7-day snapshot.
   */
  showStoredTasks?: (tasks: Task[]) => void;
  /** Adopt the Growth Tree the server returned for a replayed completion (Issue #24). */
  applyServerGrowth?: (growth: GrowthResult | undefined) => void;
  /**
   * Completion events reached the server (Issue #47, Phase 2E). The caller asks for a history reconcile so the day they belong
   * to is read back as the server's answer. This only asks: whether a completion counts as acknowledged is decided by what the
   * canonical answer lists (Phase 2C), never by the delivery itself.
   */
  onCompletionsDelivered?: () => void;
};

export function useDashboardSync({
  isOnline,
  setLoadingTasks,
  setStatusError,
  setStatusInfo,
  setTasks,
  showStoredTasks,
  applyServerGrowth,
  onCompletionsDelivered,
}: UseDashboardSyncArgs) {
  // The FACTS the sync state is derived from (Issue #58); see offline/syncState.ts for what each one means. This hook is the only
  // place they are written, and every write happens in the drain funnel, the list fetch, or a queue re-read.
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const [draining, setDraining] = useState(false);
  const [blocked, setBlocked] = useState<BlockedReason | null>(null);
  const [rejectionNotices, setRejectionNotices] = useState<RejectionNotice[]>([]);
  /**
   * INVARIANT: `confirmedAt` only advances when the queue is observed EMPTY as part of a successful synchronization: a drain
   * that sent everything without a refusal, or a list fetch followed by an empty queue. Opening the app, a local mutation, a
   * queue read or a failed drain never set it. It is cleared whenever a read finds work queued, so "Synced HH:MM" is never a
   * time from before the newest unsent change. Not persisted: a new session claims nothing until it has synchronized.
   */
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);
  const [retryingSync, setRetryingSync] = useState(false);

  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const syncState = useMemo(
    () =>
      deriveSyncState({
        online: isOnline,
        pending: pendingQueueCount,
        draining,
        blocked,
        rejections: rejectionNotices.reduce((total, notice) => total + notice.count, 0),
        confirmedAt,
      }),
    [isOnline, pendingQueueCount, draining, blocked, rejectionNotices, confirmedAt],
  );

  /** Re-reads how many changes are queued. A read finding work clears the confirmation; it never creates one. */
  const readPending = async () => {
    const queued = await getSyncQueue();
    setPendingQueueCount(queued.length);
    if (queued.length > 0) setConfirmedAt(null);
    return queued.length;
  };

  /** For the task hook after its own commit: re-read, and tell the other tabs of this browser to re-read too. */
  const refreshPendingQueueCount = async () => {
    const count = await readPending();
    announceQueueChanged();
    return count;
  };

  useEffect(() => onQueueChanged(() => void readPending().catch(() => undefined)), []);

  /**
   * A drain that THREW, as opposed to one that reported a result (the processor settles each entry itself, so a throw is
   * storage or an unexpected error). The entries are still queued and the work was not confirmed, so it is reported as
   * `unreachable`, the conservative reading ("could not sync, kept on this device, Retry"), whatever the error looks like.
   * Classifying by the error would leave an unclassified throw as a silent "not synced yet" with no way to act.
   */
  const noteDrainFailure = () => setBlocked('unreachable');

  const processPendingQueue = async () => {
    const queued = await getSyncQueue();
    setPendingQueueCount(queued.length);

    if (queued.length === 0) {
      return {
        remaining: 0,
        rejected: [] as RejectedMutation[],
        conflicts: [] as ConflictedMutation[],
        blocked: null as BlockedReason | null,
        reconciled: false,
      };
    }

    setConfirmedAt(null); // work is queued: an older confirmation no longer describes this device
    setDraining(true);

    const result = await processSyncQueue({
      // Adoption is done by the processor, in one transaction with the staleness decision (Issue #61); these only show the result.
      onTaskCreated: () => undefined,
      onTaskUpdated: () => undefined,
      onTaskDeleted: () => undefined,
      onTasksStored: (stored) => (showStoredTasks ?? setTasks)(stored),
      onGrowth: (growth) => applyServerGrowth?.(growth),
      onCompletionsDelivered: () => onCompletionsDelivered?.(),
      onDueTimeConflict: () =>
        setStatusInfo('A due time was not saved because the task’s due date was removed elsewhere. Your other changes were kept.'),
    }).catch((error) => {
      setDraining(false);
      throw error;
    });

    // The queue is the truth for how much is left (a run that found no session reports 0 for work it never touched), so it is
    // re-read rather than taken from the result. Everything below lands in one render: no frame shows "stopped" while the
    // drain is still marked as running.
    const left = (await getSyncQueue()).length;
    setPendingQueueCount(left);
    setBlocked(result.blocked);
    setDraining(false);
    const conflicted = result.conflicts ?? [];
    if (conflicted.length > 0) {
      // Nothing was saved for these and the person has to decide, so the device is not "synced" (the processor already adopted the server's values).
      setRejectionNotices((current) => [
        ...current,
        ...conflicted.map((conflict) => ({ message: describeConflict(conflict, latestTitleRef.current(conflict.taskId)), count: 1, conflict })),
      ]);
    }
    if (left === 0 && result.blocked === null && result.rejected.length === 0 && conflicted.length === 0) setConfirmedAt(new Date().toISOString());
    announceQueueChanged();

    // True when the server's state was already read back because of a refusal: callers must not fetch it a second time.
    const reconciled = result.rejected.length > 0;
    if (reconciled) await reportRejections(result.rejected);

    return { ...result, reconciled };
  };

  /**
   * The server refused changes that were already shown (Issue #57). They are not pending any more and they were not saved,
   * so: say so, stop showing those tasks as pending, and read the server's state back ONCE (no retry loop; whether to retry
   * is not decided here). Nothing about the refusal is persisted: it is shown until dismissed, for this session (Issue #58).
   */
  const reportRejections = async (rejected: RejectedMutation[]) => {
    const titleOf = (taskId: string) => latestTitleRef.current(taskId);
    const message = describeRejections(rejected, titleOf);
    if (message) setRejectionNotices((current) => [...current, { message, count: rejected.length }]);
    try {
      setTasks(await settleRejectedLocalState());
      await fetchFreshTasks();
    } catch {
      // Offline or the server is down: the tasks no longer claim to be pending, and the message above stays.
    }
  };

  // Titles of tasks as the app last showed them, for a rejection whose queue entry carried none (set by the page's list).
  const latestTitleRef = useRef<(taskId: string) => string | null>(() => null);

  /**
   * Starts a drain of the queue for work that was just committed locally (Issue #57). Never blocks the caller and never
   * runs two drains at once: a request made while one is running makes it go round once more when it finishes, so the
   * newest commit is always sent without a second concurrent run. Offline, it does nothing: the entry waits.
   */
  const drainRef = useRef({ running: false, again: false });
  const requestSync = () => {
    if (!isOnlineRef.current) return;
    const drain = drainRef.current;
    if (drain.running) {
      drain.again = true;
      return;
    }
    drain.running = true;
    void (async () => {
      try {
        do {
          drain.again = false;
          try {
            await processPendingQueue();
          } catch {
            noteDrainFailure(); // the entries are still queued; the state derives from that
          }
        } while (drain.again && isOnlineRef.current);
      } finally {
        drain.running = false;
      }
    })();
  };

  const fetchFreshTasks = async () => {
    const response = await taskService.getTasks();
    // Read, merge and store happen in ONE transaction (Issue #57): a task with work still queued keeps its local copy, so a
    // list fetched while the user was editing can never wipe out a change they already saw. The server does not know the
    // local id a task was created under; keepReminderIdentity carries it over from the stored copy.
    const merged = await reconcileServerTasks(response.tasks, (serverTask, local) => keepReminderIdentity(serverTask, local));
    setTasks(merged);

    // A successful read, and only then: it confirms the device if the queue is empty right after it (work committed while the
    // request was out keeps the queue non-empty, so nothing is claimed).
    const left = await readPending();
    if (left === 0) setConfirmedAt(new Date().toISOString());
  };

  const unreachableNoticeRef = useRef(false);
  // The browser's state NOW, not when the request started: a request that fails because the browser went offline
  // mid-flight is not evidence about the server, and `looksLikeServerTrouble` must be told so.
  const loadTasks = async () => {
    const cachedTasks = await getCachedTasks();

    if (cachedTasks.length > 0) {
      setTasks(cachedTasks);
      setLoadingTasks(false);
    }

    if (!isOnline) {
      await readPending();
      setLoadingTasks(false);
      return;
    }

    try {
      setStatusError(null);

      const queueResult = await processPendingQueue();

      if (queueResult.remaining > 0) {
        setLoadingTasks(false);
        return;
      }

      if (!queueResult.reconciled) await fetchFreshTasks();

      // The calm "server unreachable" note was ours; once a load succeeds it is no longer true.
      if (unreachableNoticeRef.current) {
        unreachableNoticeRef.current = false;
        setStatusInfo(null);
      }
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      if (looksLikeServerTrouble(axiosError, isOnlineRef.current)) {
        // The server could not be reached. That is not an error in the person's data, and the app says so elsewhere
        // (Issue #49): a calm note, not a red alarm that contradicts "you can keep working".
        setStatusInfo(
          cachedTasks.length > 0
            ? "Showing what's saved on this device. Updates will appear when the server is back."
            : 'Nothing is saved on this device yet. Your tasks will appear here when the server is back.',
        );
        unreachableNoticeRef.current = true;
        noteDrainFailure();
      } else if (cachedTasks.length > 0) {
        setStatusError('Unable to sync latest tasks. Showing cached data.');
      } else {
        setStatusError(axiosError.response?.data?.message ?? 'Unable to load tasks');
      }
    } finally {
      setLoadingTasks(false);
    }
  };

  useEffect(() => {
    setLoadingTasks(true);
    void loadTasks();
  }, [isOnline]);

  // The server came back after being unavailable (Issue #49): the work that piled up while it was away is sent and the
  // list is read fresh, exactly as when the browser comes back online, without waiting for a manual "Sync now". This
  // only starts the existing load. The count at mount
  // is the baseline, so opening the dashboard never causes a second load.
  const serverRecoveries = useServerRecoveries();
  const seenRecoveries = useRef(serverRecoveries);
  useEffect(() => {
    if (serverRecoveries === seenRecoveries.current) return;
    seenRecoveries.current = serverRecoveries;
    if (isOnline) void loadTasks();
  }, [serverRecoveries]);

  const handleRetrySync = async () => {
    if (!isOnline) {
      setStatusError('You are offline. Reconnect to retry pending sync actions.');
      return;
    }

    setStatusError(null);
    setStatusInfo(null);
    setRetryingSync(true);

    try {
      const queueResult = await processPendingQueue();

      if (queueResult.remaining > 0) {
        setRetryingSync(false);
        return;
      }

      if (!queueResult.reconciled) await fetchFreshTasks();
      if (queueResult.rejected.length === 0 && (queueResult.conflicts ?? []).length === 0) setStatusInfo('Pending sync actions completed successfully.');
    } catch (error) {
      noteDrainFailure();
      await readPending().catch(() => undefined);
      setStatusError('Retry sync failed. Pending actions were kept for another retry.');
    } finally {
      setRetryingSync(false);
    }
  };

  return {
    /** What the person is told; derived from the facts above, never set directly (Issue #58). */
    syncState,
    pendingQueueCount,
    rejectionNotices,
    // Dismiss clears the refusals; a conflict stays until it is resolved (Keep mine or Use theirs), so a decision is never lost by a stray click.
    dismissRejections: () => setRejectionNotices((current) => current.filter((notice) => notice.conflict !== undefined)),
    /** Removes one notice: "Use theirs" (the server's values were already adopted) or after "Keep mine" has been queued. */
    resolveNotice: (notice: RejectionNotice) => setRejectionNotices((current) => current.filter((item) => item !== notice)),
    retryingSync,
    refreshPendingQueueCount,
    requestSync,
    setTitleLookup: (lookup: (taskId: string) => string | null) => {
      latestTitleRef.current = lookup;
    },
    handleRetrySync,
  };
}
