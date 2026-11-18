import { useEffect, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import { useServerRecoveries } from '../launch/launchContext';
import { looksLikeServerTrouble } from '../launch/serverTrouble';
import { getCachedTasks, getLastSyncTimestamp, setLastSyncTimestamp } from '../offline/cache';
import { reconcileServerTasks, settleRejectedLocalState } from '../offline/localMutations';
import { describeRejections } from '../offline/rejections';
import { processSyncQueue, type RejectedMutation } from '../offline/queueProcessor';
import { getSyncQueue } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import type { Task } from '../types/task';
import { keepReminderIdentity } from '../reminders/identity';
import type { GrowthResult } from '../growth/treeTypes';

export type SyncStatus = 'cached' | 'syncing' | 'synced' | 'offline' | 'errors-pending';

type UseDashboardSyncArgs = {
  isOnline: boolean;
  persistTasks: (updater: (current: Task[]) => Task[]) => void;
  setLoadingTasks: (loading: boolean) => void;
  setStatusError: (message: string | null) => void;
  setStatusInfo: (message: string | null) => void;
  setTasks: (tasks: Task[]) => void;
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
  persistTasks,
  setLoadingTasks,
  setStatusError,
  setStatusInfo,
  setTasks,
  applyServerGrowth,
  onCompletionsDelivered,
}: UseDashboardSyncArgs) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const [retryingSync, setRetryingSync] = useState(false);

  const refreshPendingQueueCount = async () => {
    const queued = await getSyncQueue();
    setPendingQueueCount(queued.length);
    return queued.length;
  };

  const processPendingQueue = async () => {
    const queued = await getSyncQueue();
    setPendingQueueCount(queued.length);

    if (queued.length === 0) {
      return {
        remaining: 0,
        rejected: [] as RejectedMutation[],
        reconciled: false,
      };
    }

    setSyncStatus('syncing');

    const result = await processSyncQueue({
      onTaskCreated: (localTaskId, serverTask, { stale }) => {
        persistTasks((current) =>
          current.map((task) => {
            if (task._id !== localTaskId) return task;
            const adopted = keepReminderIdentity(serverTask, task, localTaskId);
            // The user changed the task after it was sent (Issue #57): those changes are still queued, so the local copy
            // stays as it is and only takes the server's identity, which the queue's later entries are remapped to.
            return stale ? { ...task, _id: adopted._id, clientKey: adopted.clientKey, pendingSync: true } : { ...adopted, pendingSync: false };
          }),
        );
      },
      // Stale answers never reach this callback: the processor holds them back while newer local work for the task exists.
      onTaskUpdated: (taskId, serverTask) => {
        persistTasks((current) =>
          current.map((task) => (task._id === taskId ? { ...keepReminderIdentity(serverTask, task), pendingSync: false } : task)),
        );
      },
      onTaskDeleted: (taskId) => {
        persistTasks((current) => current.filter((task) => task._id !== taskId));
      },
      onGrowth: (growth) => applyServerGrowth?.(growth),
      onCompletionsDelivered: () => onCompletionsDelivered?.(),
      onDueTimeConflict: () =>
        setStatusInfo('A due time was not saved because the task’s due date was removed elsewhere. Your other changes were kept.'),
    });

    if (result.remaining > 0) {
      setPendingQueueCount(result.remaining);
      setSyncStatus('errors-pending');
      setStatusError(`${result.remaining} queued action${result.remaining === 1 ? '' : 's'} still pending sync.`);
    } else {
      setPendingQueueCount(0);
      setSyncStatus('synced');
    }

    // True when the server's state was already read back because of a refusal: callers must not fetch it a second time.
    const reconciled = result.rejected.length > 0;
    if (reconciled) await reportRejections(result.rejected);

    return { ...result, reconciled };
  };

  /**
   * The server refused changes that were already shown (Issue #57). They are not pending any more and they were not saved,
   * so: say so, stop showing those tasks as pending, and read the server's state back ONCE (no retry loop; whether to retry
   * is not decided here). Nothing about the refusal is persisted: the message is this session's.
   */
  const reportRejections = async (rejected: RejectedMutation[]) => {
    const titleOf = (taskId: string) => latestTitleRef.current(taskId);
    setStatusError(describeRejections(rejected, titleOf));
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
            setSyncStatus('errors-pending'); // the entries are still queued; #58 owns what this state means
          }
        } while (drain.again && isOnlineRef.current);
      } finally {
        drain.running = false;
      }
    })();
  };

  const fetchFreshTasks = async () => {
    setSyncStatus('syncing');

    const response = await taskService.getTasks();
    // Read, merge and store happen in ONE transaction (Issue #57): a task with work still queued keeps its local copy, so a
    // list fetched while the user was editing can never wipe out a change they already saw. The server does not know the
    // local id a task was created under; keepReminderIdentity carries it over from the stored copy.
    const merged = await reconcileServerTasks(response.tasks, (serverTask, local) => keepReminderIdentity(serverTask, local));
    setTasks(merged);

    const syncedAt = new Date().toISOString();
    await setLastSyncTimestamp(syncedAt);
    setLastSyncAt(syncedAt);
    setSyncStatus('synced');
  };

  const unreachableNoticeRef = useRef(false);
  // The browser's state NOW, not when the request started: a request that fails because the browser went offline
  // mid-flight is not evidence about the server, and `looksLikeServerTrouble` must be told so.
  const isOnlineRef = useRef(isOnline);
  isOnlineRef.current = isOnline;

  const loadTasks = async () => {
    const cachedTasks = await getCachedTasks();
    const cachedSyncTime = await getLastSyncTimestamp();
    setLastSyncAt(cachedSyncTime);

    if (cachedTasks.length > 0) {
      setTasks(cachedTasks);
      setSyncStatus('cached');
      setLoadingTasks(false);
    }

    if (!isOnline) {
      await refreshPendingQueueCount();
      setSyncStatus('offline');
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
        if (cachedTasks.length > 0) setSyncStatus('cached');
      } else if (cachedTasks.length > 0) {
        setStatusError('Unable to sync latest tasks. Showing cached data.');
        setSyncStatus('cached');
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
      setSyncStatus('offline');
      setStatusError('You are offline. Reconnect to retry pending sync actions.');
      return;
    }

    setStatusError(null);
    setStatusInfo(null);
    setRetryingSync(true);
    setSyncStatus('syncing');

    try {
      const queueResult = await processPendingQueue();

      if (queueResult.remaining > 0) {
        setRetryingSync(false);
        return;
      }

      if (!queueResult.reconciled) await fetchFreshTasks();
      if (queueResult.rejected.length === 0) setStatusInfo('Pending sync actions completed successfully.');
    } catch {
      const remaining = await refreshPendingQueueCount();
      setSyncStatus(remaining > 0 ? 'errors-pending' : 'cached');
      setStatusError('Retry sync failed. Pending actions were kept for another retry.');
    } finally {
      setRetryingSync(false);
    }
  };

  return {
    syncStatus,
    setSyncStatus,
    lastSyncAt,
    pendingQueueCount,
    retryingSync,
    refreshPendingQueueCount,
    requestSync,
    setTitleLookup: (lookup: (taskId: string) => string | null) => {
      latestTitleRef.current = lookup;
    },
    handleRetrySync,
  };
}
