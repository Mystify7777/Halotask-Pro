import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { createReminderScheduler } from '../reminders/scheduler';
import { defaultReminderSettings } from '../reminders/settings';
import { useAuthStore } from '../store/authStore';
import { enqueueSyncAction, resetSyncQueueState } from '../offline/syncQueue';
import { useDashboardSync } from './useDashboardSync';

// Review follow-up: an offline-created task changes id when it syncs. This drives the REAL sync hook, the REAL queue
// processor and storage logic and the REAL reminder scheduler (only IndexedDB and HTTP are replaced) and asserts what
// the scheduler does across the id change. It shows that the in-session reminder is not re-armed by the sync; it does
// not show anything about other devices, a cleared cache, or a new browser session (sessionStorage is per session).

const db = vi.hoisted(() => ({ store: new Map<string, unknown>() }));
vi.mock('../offline/db', () => ({
  offlineDb: {
    get: async (key: string) => (db.store.has(key) ? structuredClone(db.store.get(key)) : null),
    set: async (key: string, value: unknown) => void db.store.set(key, structuredClone(value)),
    remove: async (key: string) => void db.store.delete(key),
  },
}));
vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), getTasks: vi.fn() },
}));

import { taskService } from '../services/taskService';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const NOON = new Date(2026, 9, 20, 12, 0, 0); // local noon, outside quiet hours
const LOCAL_ID = 'local-1700000000000-abc123';

let tasks: Task[] = [];
const persistTasks = (updater: (current: Task[]) => Task[]) => {
  tasks = updater(tasks);
  db.store.set('tasks', structuredClone(tasks));
};

beforeEach(() => {
  db.store.clear();
  sessionStorage.clear();
  resetSyncQueueState();
  useAuthStore.setState({ token: 'token-a', user: USER });
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOON);
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.getTasks).mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
});

const sentBy = () => {
  const sent: { id: string; type: string }[] = [];
  const scheduler = createReminderScheduler({
    getTasks: () => tasks,
    getSettings: () => ({ ...defaultReminderSettings }),
    onReminder: ({ task, type }) => sent.push({ id: task._id, type }),
  });
  return { sent, runNow: scheduler.runNow };
};

describe('reminder identity across the offline create -> server id change', () => {
  it('a due-soon reminder that already fired is NOT sent again after the task syncs under its server id', async () => {
    const local = makeTask({ _id: LOCAL_ID, title: 'Pay rent', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '12:30', pendingSync: true });
    const synced = makeTask({ _id: 'srv-1', title: 'Pay rent', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '12:30' });
    tasks = [local];
    await enqueueSyncAction({ type: 'create', taskId: LOCAL_ID, payload: { title: 'Pay rent', priority: 'medium', dueDate: '2026-10-20', dueTime: '12:30' } });
    vi.mocked(taskService.createTask).mockResolvedValue({ task: synced });
    vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [synced], page: 1, limit: 1, hasMore: false });
    const { sent, runNow } = sentBy();

    runNow();
    expect(sent).toEqual([{ id: LOCAL_ID, type: 'due-soon' }]);

    const { result } = renderHook(() =>
      useDashboardSync({ isOnline: true, persistTasks, setLoadingTasks: vi.fn(), setStatusError: vi.fn(), setStatusInfo: vi.fn(), setTasks: (next) => (tasks = next) }),
    );
    await act(async () => {
      await result.current.handleRetrySync();
    });

    expect(tasks.map((t) => t._id)).toEqual(['srv-1']); // the id really changed, through the queue and the refetch
    expect(tasks[0].clientKey).toBe(LOCAL_ID);
    runNow();
    runNow();
    expect(sent).toEqual([{ id: LOCAL_ID, type: 'due-soon' }]); // nothing new
  });

  it('control: keyed on the server id alone (no clientKey) the same unchanged schedule WOULD fire again', () => {
    const { sent, runNow } = sentBy();
    tasks = [makeTask({ _id: LOCAL_ID, dueDate: '2026-10-20T00:00:00.000Z', dueTime: '12:30' })];
    runNow();
    tasks = [makeTask({ _id: 'srv-1', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '12:30' })];
    runNow();
    expect(sent.map((s) => s.id)).toEqual([LOCAL_ID, 'srv-1']);
  });

  it('a changed schedule after the sync still re-arms (identity is stable, the schedule is not)', () => {
    const { sent, runNow } = sentBy();
    tasks = [makeTask({ _id: 'srv-1', clientKey: LOCAL_ID, dueDate: '2026-10-20T00:00:00.000Z', dueTime: '12:30' })];
    runNow();
    tasks = [{ ...tasks[0], dueTime: '12:45' }];
    runNow();
    expect(sent).toHaveLength(2);
  });
});
