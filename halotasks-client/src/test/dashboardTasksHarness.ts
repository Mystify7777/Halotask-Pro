import { renderHook } from '@testing-library/react';
import { useState } from 'react';
import { vi } from 'vitest';
import { useDashboardTasks } from '../hooks/useDashboardTasks';
import { getCachedTasks, setCachedTasks } from '../offline/cache';
import { offlineDb } from '../offline/db';
import { getSyncQueue, resetSyncQueueState } from '../offline/syncQueue';
import { useAuthStore } from '../store/authStore';
import type { Task } from '../types/task';

/**
 * Test harness for the dashboard task mutations (Issue #57). Every mutation is local-first now, so these tests run the REAL
 * offline layer (the `idb` code on fake-indexeddb, set up globally in setup.ts) instead of doubles: what a test reads back is
 * what was durably committed, the list and the queue together. Only the network edge (the sync drain) is a mock: `requestSync`.
 */

export const TEST_USER = { id: 'user-1', name: 'Tester', email: 't@example.com' };

export const resetOfflineStore = async () => {
  resetSyncQueueState();
  useAuthStore.setState({ token: 'tok', user: TEST_USER });
  await offlineDb.remove('tasks');
  await offlineDb.remove(`sync_queue:${TEST_USER.id}`);
};

export type MountOptions = { statusError?: (message: string | null) => void; statusInfo?: (message: string | null) => void };

/** Mounts the hook over a store seeded with `initial`. */
export const mountTasks = async (initial: Task[], isOnline: boolean, options: MountOptions = {}) => {
  await resetOfflineStore();
  await setCachedTasks(initial);
  const bridge = { setSyncStatus: vi.fn(), refreshPendingQueueCount: vi.fn(async () => 0), requestSync: vi.fn() };
  const preview = vi.fn();
  const setStatusError = vi.fn(options.statusError);
  const setStatusInfo = vi.fn(options.statusInfo);
  const rendered = renderHook(() => {
    const [tasks, setTasks] = useState<Task[]>(initial);
    const hook = useDashboardTasks({
      tasks,
      setTasks,
      isOnline,
      syncBridgeRef: { current: bridge },
      previewGrowthForCompletion: preview,
      setStatusError,
      setStatusInfo,
    });
    return { hook, tasks };
  });
  return Object.assign(rendered, { bridge, preview, setStatusError, setStatusInfo });
};

export const queuedEntries = () => getSyncQueue(TEST_USER.id);
export const storedTasks = () => getCachedTasks();
