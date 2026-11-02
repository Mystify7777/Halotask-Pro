import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Subtask, Task } from '../types/task';

// Issue #15 (phase 2) in the dashboard hook: toggleSubtask and copy-selected. The HTTP service, the offline queue and the
// cache are doubles, so this proves what the hook sends, queues and stores, and in what order, not what the server does.

vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn() },
}));
vi.mock('../offline/syncQueue', () => ({ enqueueSyncAction: vi.fn(async () => []) }));
vi.mock('../offline/cache', () => ({ setCachedTasks: vi.fn(async () => undefined) }));
vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

import { enqueueSyncAction } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import { useDashboardTasks } from './useDashboardTasks';

const sub = (id: string, completed = false): Subtask => ({ id, title: `step ${id}`, completed });
const checklist = () => [sub('a'), sub('b', true), sub('c')];

const setup = (initial: Task[], isOnline: boolean) => {
  const status = { error: vi.fn(), info: vi.fn(), growth: vi.fn(), preview: vi.fn() };
  const view = renderHook(() => {
    const [tasks, setTasks] = useState<Task[]>(initial);
    const hook = useDashboardTasks({
      tasks,
      setTasks,
      isOnline,
      syncBridgeRef: { current: { setSyncStatus: vi.fn(), refreshPendingQueueCount: vi.fn(async () => 0) } },
      previewGrowthForCompletion: status.preview,
      applyServerGrowth: status.growth,
      setStatusError: status.error,
      setStatusInfo: status.info,
    });
    return { hook, tasks };
  });
  return { ...view, status, task: (id: string) => view.result.current.tasks.find((t) => t._id === id)! };
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
const reply = (task: Task) => ({ task });

beforeEach(() => {
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(enqueueSyncAction).mockReset();
  vi.mocked(enqueueSyncAction).mockResolvedValue([]);
});

describe('toggleSubtask online', () => {
  it('sends the WHOLE next list, changes only that subtask, and never touches the parent', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    vi.mocked(taskService.updateTask).mockImplementation(async (_id, payload) => reply({ ...t, subtasks: payload.subtasks }));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'a'));

    expect(taskService.updateTask).toHaveBeenCalledWith('t1', { subtasks: [sub('a', true), sub('b', true), sub('c')] });
    expect(Object.keys(vi.mocked(taskService.updateTask).mock.calls[0][1])).toEqual(['subtasks']);
    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c')]);
    expect(m.task('t1').completed).toBe(false);
    expect(enqueueSyncAction).not.toHaveBeenCalled();
  });

  it('checking the last subtask does NOT complete the parent and awards nothing', async () => {
    const t = makeTask({ _id: 't1', subtasks: [sub('a', true), sub('b')] });
    const m = setup([t], true);
    vi.mocked(taskService.updateTask).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'b'));

    expect(m.task('t1').completed).toBe(false);
    expect(vi.mocked(taskService.updateTask).mock.calls[0][1]).not.toHaveProperty('completed');
    expect(m.status.preview).not.toHaveBeenCalled();
    expect(m.status.growth).toHaveBeenCalledWith(undefined);
  });

  it('un-checking works the same way (it sets the opposite state)', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    vi.mocked(taskService.updateTask).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'b'));

    expect(m.task('t1').subtasks).toEqual([sub('a'), sub('b'), sub('c')]);
  });

  it('an unknown task id or subtask id does nothing: no request, no queue, no state change', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);

    await act(() => m.result.current.hook.toggleSubtask('nope', 'a'));
    await act(() => m.result.current.hook.toggleSubtask('t1', 'zzz'));

    expect(taskService.updateTask).not.toHaveBeenCalled();
    expect(enqueueSyncAction).not.toHaveBeenCalled();
    expect(m.task('t1').subtasks).toEqual(checklist());
  });

  it('a task without the field (cached before it existed) is a no-op, not a crash', async () => {
    const legacy = makeTask({ _id: 'old' });
    const m = setup([legacy], true);

    await act(() => m.result.current.hook.toggleSubtask('old', 'a'));

    expect(taskService.updateTask).not.toHaveBeenCalled();
    expect(m.task('old')).not.toHaveProperty('subtasks');
  });

  it('two taps in the same tick each build on the previous result (latest state, not a stale snapshot)', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    vi.mocked(taskService.updateTask).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
      void m.result.current.hook.toggleSubtask('t1', 'c');
    });

    const [first, second] = vi.mocked(taskService.updateTask).mock.calls.map((call) => call[1].subtasks);
    expect(first).toEqual([sub('a', true), sub('b', true), sub('c')]);
    expect(second).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
  });

  it('toggling the same subtask twice quickly ends where it started', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    vi.mocked(taskService.updateTask).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
      void m.result.current.hook.toggleSubtask('t1', 'a');
    });

    expect(m.task('t1').subtasks).toEqual(checklist());
  });

  it('a late response to an OLDER tap does not overwrite a newer local tap, and keeps the rest of the server task', async () => {
    const t = makeTask({ _id: 't1', title: 'Old title', subtasks: checklist() });
    const m = setup([t], true);
    const first = deferred<ReturnType<typeof reply>>();
    vi.mocked(taskService.updateTask).mockReturnValueOnce(first.promise as never).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // request 1 stays pending
      await m.result.current.hook.toggleSubtask('t1', 'c'); // request 2 is answered
    });
    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]);

    await act(async () => {
      first.resolve(reply({ ...t, title: 'Server title', subtasks: [sub('a', true), sub('b', true), sub('c')] }));
      await first.promise;
    });

    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]); // newer local list kept
    expect(m.task('t1').title).toBe('Server title'); // everything else is still adopted
  });

  it('a failed request puts back only that subtask, shows the server message, and leaves the others', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    vi.mocked(taskService.updateTask).mockRejectedValue({ response: { data: { message: 'nope' } } });

    await act(() => m.result.current.hook.toggleSubtask('t1', 'a'));

    expect(m.task('t1').subtasks).toEqual(checklist());
    expect(m.status.error).toHaveBeenLastCalledWith('nope');
  });

  it('a failure does not undo a newer change made to the same subtask meanwhile', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    const first = deferred<never>();
    vi.mocked(taskService.updateTask).mockReturnValueOnce(first.promise as never).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // a -> true (pending)
      await m.result.current.hook.toggleSubtask('t1', 'a'); // a -> false (answered)
    });
    await act(async () => {
      first.reject({ response: { data: { message: 'late failure' } } });
      await first.promise.catch(() => undefined);
    });

    expect(m.task('t1').subtasks).toEqual(checklist()); // a is false: the newer tap stands
  });
});

describe('a failure undoes only its own tap', () => {
  it('even when a newer tap landed back on the same value the failed one had set', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], true);
    const first = deferred<never>();
    vi.mocked(taskService.updateTask).mockReturnValueOnce(first.promise as never).mockImplementation(async (_id, p) => reply({ ...t, subtasks: p.subtasks }));

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // false -> true, request pending
      await m.result.current.hook.toggleSubtask('t1', 'a'); // true -> false, answered
      await m.result.current.hook.toggleSubtask('t1', 'a'); // false -> true again, answered
    });
    await act(async () => {
      first.reject({ response: { data: { message: 'late failure' } } });
      await first.promise.catch(() => undefined);
    });

    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c')]); // the newest tap stands
  });
});

describe('toggleSubtask offline', () => {
  it('updates locally at once, marks pending, and queues the WHOLE list as an update (no request)', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], false);

    await act(() => m.result.current.hook.toggleSubtask('t1', 'c'));

    expect(taskService.updateTask).not.toHaveBeenCalled();
    expect(enqueueSyncAction).toHaveBeenCalledWith({ type: 'update', taskId: 't1', payload: { subtasks: [sub('a'), sub('b', true), sub('c', true)] } });
    expect(m.task('t1').subtasks).toEqual([sub('a'), sub('b', true), sub('c', true)]);
    expect(m.task('t1').pendingSync).toBe(true);
    expect(m.task('t1').completed).toBe(false);
  });

  it('rapid offline taps queue growing lists, each including the previous tap', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], false);

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
      void m.result.current.hook.toggleSubtask('t1', 'c');
    });

    const queued = vi.mocked(enqueueSyncAction).mock.calls.map((c) => (c[0].payload as { subtasks: Subtask[] }).subtasks);
    expect(queued[1]).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
  });

  it('if the queue write fails the tap is rolled back, including the pending flag', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = setup([t], false);
    vi.mocked(enqueueSyncAction).mockRejectedValue(new Error('storage unavailable'));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'a'));

    expect(m.task('t1').subtasks).toEqual(checklist());
    expect(m.task('t1').pendingSync).toBeUndefined();
    expect(m.status.error).toHaveBeenCalledWith(expect.stringMatching(/storage unavailable/));
  });

  it('a task created offline (local id) can have its checklist toggled; the change is queued against the local id', async () => {
    const local = makeTask({ _id: 'local-1', pendingSync: true, subtasks: checklist() });
    const m = setup([local], false);

    await act(() => m.result.current.hook.toggleSubtask('local-1', 'a'));

    expect(vi.mocked(enqueueSyncAction).mock.calls[0][0]).toMatchObject({ type: 'update', taskId: 'local-1' });
    expect(m.task('local-1').pendingSync).toBe(true);
  });
});

describe('offline: a failed queue write reconciles with what was really queued', () => {
  const holdFirstWrite = () => {
    const first = deferred<never[]>();
    vi.mocked(enqueueSyncAction).mockReset();
    vi.mocked(enqueueSyncAction).mockReturnValueOnce(first.promise as never).mockResolvedValue([]);
    return first;
  };
  const failFirst = async (first: ReturnType<typeof deferred<never[]>>) => {
    await act(async () => {
      first.reject(new Error('storage unavailable'));
      await first.promise.catch(() => undefined);
    });
  };

  it('a newer tap that was queued stands, and the task stays pending', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // a -> true, write held open
      await m.result.current.hook.toggleSubtask('t1', 'a'); // a -> false, queued
    });
    await failFirst(first);

    expect(m.task('t1').subtasks).toEqual(checklist());
    expect(m.task('t1').pendingSync).toBe(true);
  });

  it('even when the newer tap returned the subtask to the SAME value the failed tap set', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // false -> true, held
      await m.result.current.hook.toggleSubtask('t1', 'a'); // true -> false, queued
      await m.result.current.hook.toggleSubtask('t1', 'a'); // false -> true, queued
    });
    await failFirst(first);

    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c')]);
    expect(m.task('t1').pendingSync).toBe(true);
  });

  it('a failed tap that a later queued list already contains is not undone, and other subtasks are untouched', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // held, will fail
      await m.result.current.hook.toggleSubtask('t1', 'c'); // queued WITH a's change inside its list
    });
    await failFirst(first);

    expect(vi.mocked(enqueueSyncAction).mock.calls[1][0].payload).toEqual({ subtasks: [sub('a', true), sub('b', true), sub('c', true)] });
    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
    expect(m.task('t1').pendingSync).toBe(true);
  });

  it('a failure does not roll back while a later write is still in flight: the LAST write to settle decides', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = deferred<never[]>();
    const second = deferred<never[]>();
    vi.mocked(enqueueSyncAction).mockReset();
    vi.mocked(enqueueSyncAction).mockReturnValueOnce(first.promise as never).mockReturnValueOnce(second.promise as never);

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // held, will fail
      void m.result.current.hook.toggleSubtask('t1', 'c'); // held, will succeed (its list contains a's change)
    });
    await failFirst(first);
    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]); // not rolled back yet

    await act(async () => {
      second.resolve([]);
      await second.promise;
    });

    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
    expect(m.task('t1').pendingSync).toBe(true);
  });

  it('a separate edit queued while the subtask write is in flight keeps its pending flag when the subtask write fails', async () => {
    const m = setup([makeTask({ _id: 't1', title: 'Old', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a'); // held, will fail
    });
    // An unrelated edit is queued successfully meanwhile: it owns the pending flag.
    act(() => m.result.current.hook.persistTasks((list) => list.map((t) => ({ ...t, title: 'Edited', pendingSync: true }))));
    await failFirst(first);

    expect(m.task('t1').title).toBe('Edited');
    expect(m.task('t1').pendingSync).toBe(true);
    expect(m.task('t1').subtasks).toEqual(checklist()); // the failed tap is still undone
  });

  it('a concurrent sync that replaced the checklist and cleared the pending flag is not overwritten by the failure', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
    });
    act(() => m.result.current.hook.persistTasks((list) => list.map((t) => ({ ...t, subtasks: [sub('x')], pendingSync: false }))));
    await failFirst(first);

    expect(m.task('t1').subtasks).toEqual([sub('x')]);
    expect(m.task('t1').pendingSync).toBe(false);
  });

  it('a failed toggle never marks the task pending: nothing was queued', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
    });
    expect(m.task('t1').pendingSync).toBeUndefined(); // not set before the queue write succeeds
    await failFirst(first);
    expect(m.task('t1').pendingSync).toBeUndefined();
  });

  it('when every write fails the task goes back to exactly how it was, flag included', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    vi.mocked(enqueueSyncAction).mockReset();
    vi.mocked(enqueueSyncAction).mockRejectedValue(new Error('storage unavailable'));

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
      await m.result.current.hook.toggleSubtask('t1', 'c');
    });

    expect(m.task('t1').subtasks).toEqual(checklist());
    expect(m.task('t1').pendingSync).toBeUndefined();
  });

  it('a task that was already pending (earlier queued work) stays pending after a failure', async () => {
    const m = setup([makeTask({ _id: 't1', pendingSync: true, subtasks: checklist() })], false);
    vi.mocked(enqueueSyncAction).mockReset();
    vi.mocked(enqueueSyncAction).mockRejectedValue(new Error('storage unavailable'));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'a'));

    expect(m.task('t1').subtasks).toEqual(checklist());
    expect(m.task('t1').pendingSync).toBe(true);
  });

  it('an edit or sync that changed the checklist meanwhile is not overwritten by the rollback', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const first = holdFirstWrite();

    await act(async () => {
      void m.result.current.hook.toggleSubtask('t1', 'a');
    });
    act(() => m.result.current.hook.persistTasks((list) => list.map((t) => ({ ...t, subtasks: [sub('x')] }))));
    await failFirst(first);

    expect(m.task('t1').subtasks).toEqual([sub('x')]);
  });

  it('bookkeeping is per write: a later, separate failure after everything settled still rolls back', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    await act(() => m.result.current.hook.toggleSubtask('t1', 'a')); // succeeds
    vi.mocked(enqueueSyncAction).mockRejectedValueOnce(new Error('storage unavailable'));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'c')); // fails alone

    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c')]); // back to the last queued list
    expect(m.task('t1').pendingSync).toBe(true);
  });
});

describe('copy-selected with description and subtasks', () => {
  const copy = async (tasks: Task[]) => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const m = setup(tasks, true);
    act(() => m.result.current.hook.setFilterMode('all'));
    act(() => tasks.forEach((t) => m.result.current.hook.toggleSelect(t._id)));
    await act(() => m.result.current.hook.handleCopySelected());
    return writeText.mock.calls[0]?.[0] as string | undefined;
  };

  it('a task without description or subtasks copies exactly as before', async () => {
    const t = makeTask({ _id: 'p', title: 'Plain', priority: 'high', tags: ['x'], estimatedMinutes: 15 });
    expect(await copy([t])).toBe('• [high] Plain (~15m) #x');
  });

  it('adds the description, then one [x]/[ ] line per subtask in order', async () => {
    const t = makeTask({ _id: 'r', title: 'Trip', priority: 'low', description: '  Pack light  ', subtasks: [sub('a', true), sub('b')] });
    expect(await copy([t])).toBe('• [low] Trip\nPack light\n  [x] step a\n  [ ] step b');
  });

  it('subtasks without a description, and several tasks, each keep their own block', async () => {
    const a = makeTask({ _id: 'a1', title: 'A', priority: 'low', subtasks: [sub('x')] });
    const b = makeTask({ _id: 'b1', title: 'B', priority: 'low' });
    const text = (await copy([a, b]))!.split('\n');
    expect(text.filter((l) => l.startsWith('•')).length).toBe(2);
    expect(text).toContain('  [ ] step x');
  });
});
