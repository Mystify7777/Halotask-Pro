import { useEffect, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import { getCachedTasks, getLastSyncTimestamp, setCachedTasks, setLastSyncTimestamp } from '../offline/cache';
import { processSyncQueue } from '../offline/queueProcessor';
import { getSyncQueue } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import type { Task } from '../types/task';

export type SyncStatus = 'cached' | 'syncing' | 'synced' | 'offline' | 'errors-pending';

// 'idle'   — no cold-start warmup is in progress (fast load, or nothing to wait on)
// 'waking' — the request has taken long enough that the backend is likely cold-starting
// 'ready'  — the backend genuinely responded successfully; safe to show a "ready" state
// 'error'  — the wait ended without a successful response; never reported as "ready"
export type ColdStartPhase = 'idle' | 'waking' | 'ready' | 'error';

type UseDashboardSyncArgs = {
  isOnline: boolean;
  persistTasks: (updater: (current: Task[]) => Task[]) => void;
  setLoadingTasks: (loading: boolean) => void;
  setStatusError: (message: string | null) => void;
  setStatusInfo: (message: string | null) => void;
  setTasks: (tasks: Task[]) => void;
};

export function useDashboardSync({
  isOnline,
  persistTasks,
  setLoadingTasks,
  setStatusError,
  setStatusInfo,
  setTasks,
}: UseDashboardSyncArgs) {
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);
  const [pendingQueueCount, setPendingQueueCount] = useState(0);
  const [retryingSync, setRetryingSync] = useState(false);
  const [coldStartPhase, setColdStartPhase] = useState<ColdStartPhase>('idle');
  const coldStartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Identifies the current load attempt so a stale timer/callback from a
  // previous cycle can never flip the phase for a load that already ended.
  const coldStartCycleRef = useRef(0);

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
      };
    }

    setSyncStatus('syncing');

    const result = await processSyncQueue({
      onTaskCreated: (localTaskId, serverTask) => {
        persistTasks((current) =>
          current.map((task) => (task._id === localTaskId ? { ...serverTask, pendingSync: false } : task)),
        );
      },
      onTaskUpdated: (taskId, serverTask) => {
        persistTasks((current) => current.map((task) => (task._id === taskId ? { ...serverTask, pendingSync: false } : task)));
      },
      onTaskDeleted: (taskId) => {
        persistTasks((current) => current.filter((task) => task._id !== taskId));
      },
    });

    if (result.remaining > 0) {
      setPendingQueueCount(result.remaining);
      setSyncStatus('errors-pending');
      setStatusError(`${result.remaining} queued action${result.remaining === 1 ? '' : 's'} still pending sync.`);
    } else {
      setPendingQueueCount(0);
      setSyncStatus('synced');
    }

    return result;
  };

  const fetchFreshTasks = async () => {
    setSyncStatus('syncing');

    const response = await taskService.getTasks();
    const freshTasks = response.tasks.map((task) => ({ ...task, pendingSync: false }));
    setTasks(freshTasks);
    await setCachedTasks(freshTasks);

    const syncedAt = new Date().toISOString();
    await setLastSyncTimestamp(syncedAt);
    setLastSyncAt(syncedAt);
    setSyncStatus('synced');
  };

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

    if (coldStartTimerRef.current) {
      clearTimeout(coldStartTimerRef.current);
    }

    // New load cycle: any overlay driven by a previous cycle's outcome is done.
    const cycleId = ++coldStartCycleRef.current;
    setColdStartPhase('idle');

    coldStartTimerRef.current = setTimeout(() => {
      if (coldStartCycleRef.current === cycleId) {
        setColdStartPhase('waking');
      }
    }, 3000);

    try {
      setStatusError(null);

      const queueResult = await processPendingQueue();

      if (queueResult.remaining > 0) {
        if (coldStartCycleRef.current === cycleId) {
          setColdStartPhase((current) => (current === 'waking' ? 'error' : 'idle'));
        }
        setLoadingTasks(false);
        return;
      }

      await fetchFreshTasks();

      // Only a real, successful response counts as "ready" — a request that
      // resolved fast (before the warmup UI ever appeared) has nothing to report.
      if (coldStartCycleRef.current === cycleId) {
        setColdStartPhase((current) => (current === 'waking' ? 'ready' : 'idle'));
      }
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      if (cachedTasks.length > 0) {
        setStatusError('Unable to sync latest tasks. Showing cached data.');
        setSyncStatus('cached');
      } else {
        setStatusError(axiosError.response?.data?.message ?? 'Unable to load tasks');
      }

      // A failure never gets reported as "ready" — the backend may genuinely
      // still be unavailable, and the overlay must not claim otherwise.
      if (coldStartCycleRef.current === cycleId) {
        setColdStartPhase((current) => (current === 'waking' ? 'error' : 'idle'));
      }
    } finally {
      if (coldStartTimerRef.current) {
        clearTimeout(coldStartTimerRef.current);
        coldStartTimerRef.current = null;
      }
      setLoadingTasks(false);
    }
  };

  useEffect(
    () => () => {
      if (coldStartTimerRef.current) {
        clearTimeout(coldStartTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    setLoadingTasks(true);
    void loadTasks();
  }, [isOnline]);

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

      await fetchFreshTasks();
      setStatusInfo('Pending sync actions completed successfully.');
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
    coldStartPhase,
    refreshPendingQueueCount,
    handleRetrySync,
  };
}
