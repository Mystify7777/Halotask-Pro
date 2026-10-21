import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';

// Issues #9 and #10 in the create/edit flow: what the form state turns into on the wire and in the local cache,
// online and offline, including clearing a field and the values the form must not send. The HTTP service, the
// offline queue and the cache are doubles: this proves what the hook sends and stores, not what the server does with it.

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn() },
}));
vi.mock('../offline/syncQueue', () => ({ enqueueSyncAction: vi.fn(async () => []) }));
vi.mock('../offline/cache', () => ({ setCachedTasks: vi.fn(async () => undefined) }));
vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

import { enqueueSyncAction } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import { useDashboardTasks } from './useDashboardTasks';

const submit = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;

const mount = (initial: Task[], isOnline: boolean) =>
  renderHook(() => {
    const [tasks, setTasks] = useState<Task[]>(initial);
    const hook = useDashboardTasks({
      tasks,
      setTasks,
      isOnline,
      syncBridgeRef: { current: { setSyncStatus: vi.fn(), refreshPendingQueueCount: vi.fn(async () => 0) } },
      previewGrowthForCompletion: vi.fn(),
      applyServerGrowth: vi.fn(),
      setStatusError: vi.fn(),
      setStatusInfo: vi.fn(),
    });
    return { hook, tasks };
  });

type Mounted = ReturnType<typeof mount>;

const fillCreateForm = (m: Mounted, fields: { dueDate?: string; dueTime?: string; startTime?: string }) => {
  act(() => m.result.current.hook.setTitle('Write report'));
  if (fields.dueDate !== undefined) act(() => m.result.current.hook.setDueDate(fields.dueDate!));
  if (fields.dueTime !== undefined) act(() => m.result.current.hook.setDueTime(fields.dueTime!));
  if (fields.startTime !== undefined) act(() => m.result.current.hook.setStartTime(fields.startTime!));
};

const created = (extra: Partial<Task> = {}) => ({ task: makeTask({ _id: 'srv-1', title: 'Write report', ...extra }) });

beforeEach(() => {
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(enqueueSyncAction).mockClear();
  vi.mocked(taskService.createTask).mockResolvedValue(created());
  vi.mocked(taskService.updateTask).mockResolvedValue(created());
});

const sentCreate = () => vi.mocked(taskService.createTask).mock.calls[0][0];
const sentUpdate = () => vi.mocked(taskService.updateTask).mock.calls[0][1];

describe('creating a task (online)', () => {
  it('sends a due time next to the due date and a start time as the instant the local entry names', async () => {
    const m = mount([], true);
    fillCreateForm(m, { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30' });

    await act(() => m.result.current.hook.handleCreateTask(submit));

    const payload = sentCreate();
    expect(payload).toMatchObject({ title: 'Write report', dueDate: '2026-10-20', dueTime: '17:30' });
    expect(payload.startTime).toBe(new Date(2026, 9, 20, 9, 30).toISOString());
  });

  it('start time alone (no due date) is allowed', async () => {
    const m = mount([], true);
    fillCreateForm(m, { dueDate: '', startTime: '2026-10-20T09:30' });

    await act(() => m.result.current.hook.handleCreateTask(submit));

    expect(sentCreate().dueDate).toBeUndefined();
    expect(sentCreate().dueTime).toBeUndefined();
    expect(sentCreate().startTime).toBe(new Date(2026, 9, 20, 9, 30).toISOString());
  });

  it('a due date without a time, and a task with neither, send no time fields at all', async () => {
    const dateOnly = mount([], true);
    fillCreateForm(dateOnly, { dueDate: '2026-10-20' });
    await act(() => dateOnly.result.current.hook.handleCreateTask(submit));
    expect(sentCreate().dueTime).toBeUndefined();
    expect(sentCreate().startTime).toBeUndefined();

    vi.mocked(taskService.createTask).mockClear();
    const neither = mount([], true);
    fillCreateForm(neither, { dueDate: '' });
    await act(() => neither.result.current.hook.handleCreateTask(submit));
    expect(sentCreate().dueDate).toBeUndefined();
    expect(sentCreate().dueTime).toBeUndefined();
    expect(sentCreate().startTime).toBeUndefined();
  });

  it('never sends a due time without a due date: clearing the date clears the time, and a stale time is dropped', async () => {
    const m = mount([], true);
    fillCreateForm(m, { dueDate: '2026-10-20', dueTime: '17:30' });
    act(() => m.result.current.hook.setDueDate('')); // the user clears the date

    expect(m.result.current.hook.dueTime).toBe('');

    await act(() => m.result.current.hook.handleCreateTask(submit));
    expect(sentCreate().dueTime).toBeUndefined();
  });

  it.each([
    ['an invalid due time', { dueDate: '2026-10-20', dueTime: '25:61' }],
    ['a half-typed due time', { dueDate: '2026-10-20', dueTime: '17:' }],
  ])('drops %s instead of sending something the server would reject', async (_label, fields) => {
    const m = mount([], true);
    fillCreateForm(m, fields);

    await act(() => m.result.current.hook.handleCreateTask(submit));

    expect(sentCreate().dueDate).toBe('2026-10-20');
    expect(sentCreate().dueTime).toBeUndefined();
  });

  it('drops an incomplete or impossible start entry', async () => {
    for (const startTime of ['2026-10-20', '2026-10-20T', '2026-02-30T09:30']) {
      vi.mocked(taskService.createTask).mockClear();
      const m = mount([], true);
      fillCreateForm(m, { dueDate: '2026-10-20', startTime });
      await act(() => m.result.current.hook.handleCreateTask(submit));
      expect(sentCreate().startTime, startTime).toBeUndefined();
    }
  });

  it('keeps the times on the task it stores, and resets the form for the next one', async () => {
    vi.mocked(taskService.createTask).mockResolvedValue(created({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', startTime: '2026-10-20T04:00:00.000Z' }));
    const m = mount([], true);
    fillCreateForm(m, { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30' });

    await act(() => m.result.current.hook.handleCreateTask(submit));

    expect(m.result.current.tasks[0]).toMatchObject({ dueTime: '17:30', startTime: '2026-10-20T04:00:00.000Z' });
    expect(m.result.current.hook.dueTime).toBe('');
    expect(m.result.current.hook.startTime).toBe('');
  });
});

describe('creating a task (offline)', () => {
  it('stores the times on the local task and queues them, so they survive until sync', async () => {
    const m = mount([], false);
    fillCreateForm(m, { dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30' });

    await act(() => m.result.current.hook.handleCreateTask(submit));

    expect(taskService.createTask).not.toHaveBeenCalled();
    const expectedStart = new Date(2026, 9, 20, 9, 30).toISOString();
    expect(m.result.current.tasks[0]).toMatchObject({ dueDate: '2026-10-20', dueTime: '17:30', startTime: expectedStart, pendingSync: true });
    const queued = vi.mocked(enqueueSyncAction).mock.calls[0][0];
    expect(queued).toMatchObject({ type: 'create', taskId: m.result.current.tasks[0]._id });
    expect(queued.payload).toMatchObject({ dueDate: '2026-10-20', dueTime: '17:30', startTime: expectedStart });
  });
});

describe('editing a task', () => {
  const timed = () =>
    makeTask({
      _id: 'srv-1',
      title: 'Write report',
      dueDate: '2026-10-20T00:00:00.000Z',
      dueTime: '17:30',
      startTime: '2026-10-20T09:30:45.250Z', // seconds and milliseconds: the form input only shows minutes
    });

  it('loads both times into the edit form', () => {
    const task = timed();
    const m = mount([task], true);

    act(() => m.result.current.hook.handleStartEditing(task));

    expect(m.result.current.hook.editState).toMatchObject({ dueDate: '2026-10-20', dueTime: '17:30' });
    const start = m.result.current.hook.editState!.startTime;
    expect(start).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
    expect(new Date(start).getTime()).toBe(Math.floor(new Date(task.startTime!).getTime() / 60_000) * 60_000);
  });

  it('an edit of an unrelated field sends the stored times back UNCHANGED, including the seconds the form cannot show', async () => {
    const task = timed();
    const m = mount([task], true);
    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((current) => (current ? { ...current, title: 'Write report v2' } : current)));

    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(sentUpdate()).toMatchObject({ title: 'Write report v2', dueDate: '2026-10-20', dueTime: '17:30', startTime: '2026-10-20T09:30:45.250Z' });
  });

  it('changing the start time sends the new instant', async () => {
    const task = timed();
    const m = mount([task], true);
    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((current) => (current ? { ...current, startTime: '2026-10-21T07:15' } : current)));

    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(sentUpdate().startTime).toBe(new Date(2026, 9, 21, 7, 15).toISOString());
  });

  it('clearing the due time and the start time sends null for each (null is what clears on the server)', async () => {
    const task = timed();
    const m = mount([task], true);
    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((current) => (current ? { ...current, dueTime: '', startTime: '' } : current)));

    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(sentUpdate()).toMatchObject({ dueDate: '2026-10-20', dueTime: null, startTime: null });
  });

  it('clearing the due date sends a null due time with it, even if the time field still holds a value', async () => {
    const task = timed();
    const m = mount([task], true);
    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((current) => (current ? { ...current, dueDate: '' } : current))); // time left behind

    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(sentUpdate()).toMatchObject({ dueDate: null, dueTime: null });
  });

  it('an invalid due time in the form is sent as a clear, never as a value the server would reject', async () => {
    const task = timed();
    const m = mount([task], true);
    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((current) => (current ? { ...current, dueTime: '99:99' } : current)));

    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(sentUpdate().dueTime).toBeNull();
  });

  it('a legacy task (no times) edits without gaining any: both are sent as null, i.e. "none"', async () => {
    const legacy = makeTask({ _id: 'srv-1', title: 'old', dueDate: '2026-04-21T00:00:00.000Z' });
    const m = mount([legacy], true);
    act(() => m.result.current.hook.handleStartEditing(legacy));

    expect(m.result.current.hook.editState).toMatchObject({ dueTime: '', startTime: '' });
    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(sentUpdate()).toMatchObject({ dueDate: '2026-04-21', dueTime: null, startTime: null });
  });

  it('offline: the local task and the queued update both carry the edited and the cleared times', async () => {
    const task = timed();
    const m = mount([task], false);
    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((current) => (current ? { ...current, dueTime: '08:05', startTime: '' } : current)));

    await act(() => m.result.current.hook.handleSaveTaskEdit('srv-1'));

    expect(taskService.updateTask).not.toHaveBeenCalled();
    expect(m.result.current.tasks[0]).toMatchObject({ dueDate: '2026-10-20', dueTime: '08:05', pendingSync: true });
    expect(m.result.current.tasks[0].startTime).toBeUndefined();
    expect(vi.mocked(enqueueSyncAction).mock.calls[0][0].payload).toMatchObject({ dueTime: '08:05', startTime: null });
  });

  it('completing a task sends only the completion, so it cannot disturb the times', async () => {
    const task = timed();
    const m = mount([task], true);

    await act(() => m.result.current.hook.handleToggleTask(task));

    expect(vi.mocked(taskService.updateTask).mock.calls[0][1]).toEqual({ completed: true });
  });
});
