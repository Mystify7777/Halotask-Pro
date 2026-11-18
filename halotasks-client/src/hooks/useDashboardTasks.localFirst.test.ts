import { act } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { mountTasks, queuedEntries, storedTasks } from '../test/dashboardTasksHarness';

// Issue #57: the local-first contract of the dashboard's task mutations, end to end through the hook on the real offline
// layer (fake-indexeddb). Durable first, render second; refused means nothing written; rapid mutations never lose one;
// per-task ordering holds. fake-indexeddb does not prove crash durability or multi-tab semantics of a real browser.

vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

const submit = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
beforeEach(() => vi.clearAllMocks());

describe('durable before visible', () => {
  it('nothing is rendered until the local commit has resolved, and what is rendered is what was committed', async () => {
    const m = await mountTasks([], true);
    const { offlineDb } = await import('../offline/db');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const real = offlineDb.transaction.bind(offlineDb);
    const spy = vi.spyOn(offlineDb, 'transaction').mockImplementation(async (fn) => {
      await gate; // the commit is "in flight"
      return real(fn);
    });

    act(() => m.result.current.hook.setTitle('Slow'));
    let pending!: Promise<void>;
    act(() => {
      pending = m.result.current.hook.handleCreateTask(submit);
    });
    await act(async () => { await Promise.resolve(); });
    expect(m.result.current.tasks).toHaveLength(0); // not committed, not shown
    expect(await storedTasks()).toEqual([]);

    await act(async () => {
      release();
      await pending;
    });
    spy.mockRestore();
    expect(m.result.current.tasks.map((t) => t.title)).toEqual(['Slow']);
    expect((await storedTasks()).map((t) => t.title)).toEqual(['Slow']);
    expect(m.result.current.tasks[0]._id).toMatch(/^local-/);
  });

  it('a storage failure on create shows nothing, keeps the form, and says so', async () => {
    const m = await mountTasks([], true);
    const { offlineDb } = await import('../offline/db');
    const spy = vi.spyOn(offlineDb, 'transaction').mockRejectedValueOnce(new Error('quota'));
    act(() => m.result.current.hook.setTitle('Keep me'));
    await act(() => m.result.current.hook.handleCreateTask(submit));
    spy.mockRestore();
    expect(m.result.current.tasks).toHaveLength(0);
    expect(m.result.current.hook.title).toBe('Keep me');
    expect(m.setStatusError).toHaveBeenCalledWith(expect.stringMatching(/storage unavailable/));
    expect(await queuedEntries()).toEqual([]);
  });

  it('locally invalid input (a title over the limit) is refused before anything is written', async () => {
    const m = await mountTasks([], true);
    act(() => m.result.current.hook.setTitle('x'.repeat(201)));
    await act(() => m.result.current.hook.handleCreateTask(submit));
    expect(m.setStatusError).toHaveBeenCalledWith(expect.stringMatching(/200/));
    expect(await queuedEntries()).toEqual([]);
    expect(await storedTasks()).toEqual([]);
  });
});

describe('rapid sequential mutations', () => {
  it('twenty creates in the same tick are all kept, each with its own local id, queued in call order', async () => {
    const m = await mountTasks([], false);
    await act(async () => {
      await Promise.all(
        Array.from({ length: 20 }, async (_, i) => {
          // each "call" is a separate user action with its own form state snapshot: drive the commit through the hook's create
          act(() => m.result.current.hook.setTitle(`T${i}`));
          return m.result.current.hook.handleCreateTask(submit);
        }),
      );
    });
    const stored = await storedTasks();
    const queue = await queuedEntries();
    expect(stored.length).toBe(queue.length);
    expect(new Set(stored.map((t) => t._id)).size).toBe(stored.length);
    expect(queue.every((e) => e.type === 'create')).toBe(true);
    expect(m.result.current.tasks.map((t) => t._id).sort()).toEqual(stored.map((t) => t._id).sort());
  });

  it('delete then re-create then delete: A is not lost to B (each derives from the stored result of the previous)', async () => {
    const a = makeTask({ _id: 'a', title: 'A' });
    const b = makeTask({ _id: 'b', title: 'B' });
    const m = await mountTasks([a, b], false);
    await act(async () => {
      await Promise.all([m.result.current.hook.handleDeleteTask('a'), m.result.current.hook.handleDeleteTask('b')]);
    });
    expect(await storedTasks()).toEqual([]);
    expect((await queuedEntries()).map((e) => `${e.type}:${e.taskId}`)).toEqual(['delete:a', 'delete:b']);
  });
});

describe('per-task ordering (the issue\'s sequence)', () => {
  it('edit title, complete, edit priority, delete keeps what must stay and in order: [completion, delete]', async () => {
    const task = makeTask({ _id: 's1', title: 'T', priority: 'low' });
    const m = await mountTasks([task], false);

    act(() => m.result.current.hook.handleStartEditing(task));
    act(() => m.result.current.hook.setEditState((c) => ({ ...c!, title: 'T2' })));
    await act(() => m.result.current.hook.handleSaveTaskEdit('s1'));
    await act(() => m.result.current.hook.handleToggleTask(m.result.current.tasks[0]));
    act(() => m.result.current.hook.handleStartEditing(m.result.current.tasks[0]));
    act(() => m.result.current.hook.setEditState((c) => ({ ...c!, priority: 'high' })));
    await act(() => m.result.current.hook.handleSaveTaskEdit('s1'));

    expect((await queuedEntries()).map((e) => e.type)).toEqual(['update', 'completion']);
    expect((await queuedEntries())[0].payload).toMatchObject({ title: 'T2', priority: 'high' });

    await act(() => m.result.current.hook.handleDeleteTask('s1'));
    expect((await queuedEntries()).map((e) => e.type)).toEqual(['completion', 'delete']);
    expect(await storedTasks()).toEqual([]);
  });

  it('deleting a task that only exists locally cancels its queued create: nothing is ever sent for it', async () => {
    const m = await mountTasks([], false);
    act(() => m.result.current.hook.setTitle('Temp'));
    await act(() => m.result.current.hook.handleCreateTask(submit));
    const id = m.result.current.tasks[0]._id;
    await act(() => m.result.current.hook.handleDeleteTask(id));
    expect(await queuedEntries()).toEqual([]);
    expect(await storedTasks()).toEqual([]);
  });
});

describe('bulk mutations', () => {
  it('clear completed deletes the tasks that are completed in the STORED list, one delete entry each, atomically', async () => {
    const m = await mountTasks([makeTask({ _id: 'a', completed: true }), makeTask({ _id: 'b' }), makeTask({ _id: 'c', completed: true })], true);
    await act(() => m.result.current.hook.handleClearCompleted());
    expect((await storedTasks()).map((t) => t._id)).toEqual(['b']);
    expect((await queuedEntries()).map((e) => `${e.type}:${e.taskId}`)).toEqual(['delete:a', 'delete:c']);
    expect(m.bridge.requestSync).toHaveBeenCalledTimes(1);
    expect(m.result.current.tasks.map((t) => t._id)).toEqual(['b']);
  });

  it('delete selected removes exactly the confirmed selection and queues one delete per task', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const m = await mountTasks([makeTask({ _id: 'a' }), makeTask({ _id: 'b' }), makeTask({ _id: 'c' })], false);
    act(() => m.result.current.hook.toggleSelect('a'));
    act(() => m.result.current.hook.toggleSelect('c'));
    await act(() => m.result.current.hook.handleDeleteSelected());
    expect((await storedTasks()).map((t) => t._id)).toEqual(['b']);
    expect((await queuedEntries()).map((e) => e.taskId)).toEqual(['a', 'c']);
  });

  it('declining the confirmation changes nothing', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const m = await mountTasks([makeTask({ _id: 'a' })], false);
    act(() => m.result.current.hook.toggleSelect('a'));
    await act(() => m.result.current.hook.handleDeleteSelected());
    expect(await queuedEntries()).toEqual([]);
    expect(m.result.current.tasks).toHaveLength(1);
  });
});

describe('writers that are not user mutations never clobber a committed one', () => {
  it('persistTasks (a sync adoption, AI creation) is applied to the STORED list, so a commit made just before it is kept', async () => {
    const m = await mountTasks([makeTask({ _id: 'a', title: 'A' })], false);
    await act(async () => {
      const commit = m.result.current.hook.handleDeleteTask('a');
      m.result.current.hook.persistTasks((current) => [...current, makeTask({ _id: 'ai-1', title: 'AI' })]);
      await commit;
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect((await storedTasks()).map((t) => t._id)).toEqual(['ai-1']); // 'a' stays deleted
    expect(m.result.current.tasks.map((t) => t._id)).toEqual(['ai-1']);
  });
});
