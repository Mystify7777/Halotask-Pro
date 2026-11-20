import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { mountTasks, queuedEntries, storedTasks } from '../test/dashboardTasksHarness';

// Issue #47, Phase 2E + Issue #57: what the dashboard writers commit when a task is completed or re-opened. Every
// completion is local-first: ONE `completion` entry is committed together with the task, whether the device is online
// (the entry is then sent by the background drain) or offline (it waits). The offline layer is real (fake-indexeddb); only
// the drain (`requestSync`) is a double. Delivery of the entry is proven in completionPipeline.test.ts.

vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

beforeEach(() => vi.clearAllMocks());

type Payload = { kind: string; completionId?: string };

describe('completing from the dashboard checkbox', () => {
  it('online: ONE completion entry is committed with the task, the drain is kicked, and nothing is sent from here', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = await mountTasks([task], true);

    await act(() => m.result.current.hook.handleToggleTask(task));

    const entries = await queuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'completion', taskId: 'srv-1', payload: { kind: 'complete', completionId: expect.any(String), completedAt: expect.any(String), utcOffsetMinutes: expect.any(Number) } });
    expect(m.bridge.requestSync).toHaveBeenCalledTimes(1);
    const completionId = (entries[0].payload as Payload).completionId;
    expect(m.result.current.tasks[0]).toMatchObject({ completed: true, pendingSync: true, completionId });
    expect((await storedTasks())[0]).toMatchObject({ completed: true, completionId }); // committed, not just rendered
  });

  it('offline: the same entry is committed, the drain is NOT kicked, and the preview growth is shown', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = await mountTasks([task], false);

    await act(() => m.result.current.hook.handleToggleTask(task));

    expect(await queuedEntries()).toHaveLength(1);
    expect(m.bridge.requestSync).not.toHaveBeenCalled();
    expect(m.result.current.tasks[0]).toMatchObject({ completed: true, pendingSync: true });
    expect(m.preview).toHaveBeenCalledWith('srv-1');
  });

  it('a task that has not reached the server yet is committed against its local id', async () => {
    const task = makeTask({ _id: 'local-9', completed: false });
    const m = await mountTasks([task], true);
    await act(() => m.result.current.hook.handleToggleTask(task));
    expect((await queuedEntries())[0]).toMatchObject({ type: 'completion', taskId: 'local-9' });
  });

  it('re-opening names the completion the task holds, online and offline, and earns no Growth', async () => {
    const task = makeTask({ _id: 'srv-1', completed: true, completionId: 'c-held' });
    for (const online of [true, false]) {
      const m = await mountTasks([task], online);
      await act(() => m.result.current.hook.handleToggleTask(task));
      expect((await queuedEntries())[0]).toMatchObject({ type: 'completion', payload: { kind: 'revoke', completionId: 'c-held' } });
      expect(m.preview).not.toHaveBeenCalled();
    }
  });

  it('is built from the STORED task, not the stale object a render captured: a double tap is a completion then a revocation of that same completion', async () => {
    const stale = makeTask({ _id: 'srv-1', completed: false });
    const m = await mountTasks([stale], false);

    await act(async () => {
      await m.result.current.hook.handleToggleTask(stale);
      await m.result.current.hook.handleToggleTask(stale); // the same stale object again
    });

    const [first, second] = (await queuedEntries()).map((q) => q.payload as Payload);
    expect(first.kind).toBe('complete');
    expect(second).toMatchObject({ kind: 'revoke', completionId: first.completionId });
  });

  it('two taps fired in the same tick (not awaited one after the other) are both kept, in order', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = await mountTasks([task], false);

    await act(async () => {
      await Promise.all([m.result.current.hook.handleToggleTask(task), m.result.current.hook.handleToggleTask(task)]);
    });

    expect((await queuedEntries()).map((q) => (q.payload as Payload).kind)).toEqual(['complete', 'revoke']);
    expect((await storedTasks())[0].completed).toBe(false);
  });

  it('a storage failure leaves the task as it was and says so (no optimistic flip without an event behind it)', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = await mountTasks([task], false);
    const { offlineDb } = await import('../offline/db');
    const spy = vi.spyOn(offlineDb, 'transaction').mockRejectedValueOnce(new Error('quota'));

    await act(() => m.result.current.hook.handleToggleTask(task));
    spy.mockRestore();

    expect(m.result.current.tasks[0].completed).toBe(false);
    expect(await queuedEntries()).toEqual([]);
    expect(m.setStatusError).toHaveBeenCalledWith(expect.stringMatching(/storage unavailable/));
  });

  it('a task that no longer exists is refused with a message, and nothing is written', async () => {
    const task = makeTask({ _id: 'srv-1', completed: false });
    const m = await mountTasks([], false);
    await act(() => m.result.current.hook.handleToggleTask(task));
    expect(await queuedEntries()).toEqual([]);
    expect(m.setStatusError).toHaveBeenCalledWith(expect.stringMatching(/no longer exists/i));
  });

  it('completing an already-completed task is NOT refused: completion semantics are the existing ones (it re-opens)', async () => {
    const task = makeTask({ _id: 'srv-1', completed: true, completionId: 'c1' });
    const m = await mountTasks([task], false);
    await act(() => m.result.current.hook.handleToggleTask(task));
    expect(m.setStatusError).not.toHaveBeenCalledWith(expect.any(String));
    expect((await queuedEntries())).toHaveLength(1);
  });
});

describe('bulk "mark complete"', () => {
  const select = async (m: Awaited<ReturnType<typeof mountTasks>>, ids: string[]) => {
    for (const id of ids) act(() => m.result.current.hook.toggleSelect(id));
  };

  it.each([true, false])('online=%s: one completion entry and one distinct event per task, committed together', async (online) => {
    const m = await mountTasks([makeTask({ _id: 'srv-1' }), makeTask({ _id: 'srv-2' })], online);
    await select(m, ['srv-1', 'srv-2']);

    await act(() => m.result.current.hook.handleMarkSelectedComplete());

    const entries = await queuedEntries();
    expect(entries.map((q) => [q.type, q.taskId])).toEqual([['completion', 'srv-1'], ['completion', 'srv-2']]);
    expect(new Set(entries.map((q) => (q.payload as Payload).completionId)).size).toBe(2);
    expect(m.result.current.tasks.every((t) => t.completed && t.pendingSync)).toBe(true);
    expect((await storedTasks()).every((t) => t.completed)).toBe(true);
    expect(m.bridge.requestSync).toHaveBeenCalledTimes(online ? 1 : 0);
  });

  it('skips a selected task that is already completed in the stored list: no second event for it', async () => {
    const m = await mountTasks([makeTask({ _id: 'srv-1' }), makeTask({ _id: 'srv-2', completed: true, completionId: 'c2' })], false);
    await select(m, ['srv-1', 'srv-2']);
    await act(() => m.result.current.hook.handleMarkSelectedComplete());
    expect((await queuedEntries()).map((q) => q.taskId)).toEqual(['srv-1']);
  });
});
