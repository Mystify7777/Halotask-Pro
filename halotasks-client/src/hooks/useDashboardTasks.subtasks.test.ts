import { act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { mountTasks, queuedEntries, storedTasks } from '../test/dashboardTasksHarness';
import type { Subtask, Task } from '../types/task';

// Issue #15 (phase 2) in the dashboard hook: toggleSubtask and copy-selected; Issue #57 made the toggle local-first. The
// toggle derives the next list from the STORED task inside one commit that also writes the queue entry, so there is no
// rollback to test any more: a failed commit stores nothing. The offline layer is real (fake-indexeddb); the drain is a double.

vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

const sub = (id: string, completed = false): Subtask => ({ id, title: `step ${id}`, completed });
const checklist = () => [sub('a'), sub('b', true), sub('c')];

const setup = async (initial: Task[], isOnline: boolean) => {
  const view = await mountTasks(initial, isOnline);
  return Object.assign(view, { status: { error: view.setStatusError, info: view.setStatusInfo, preview: view.preview }, task: (id: string) => view.result.current.tasks.find((t) => t._id === id)! });
};

beforeEach(() => vi.clearAllMocks());

describe.each([true, false])('toggleSubtask (online=%s)', (online) => {
  it('commits the WHOLE next list as one update, changes only that subtask, and never touches the parent', async () => {
    const t = makeTask({ _id: 't1', subtasks: checklist() });
    const m = await setup([t], online);

    await act(() => m.result.current.hook.toggleSubtask('t1', 'a'));

    const next = [sub('a', true), sub('b', true), sub('c')];
    const entries = await queuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'update', taskId: 't1' });
    expect(Object.keys(entries[0].payload as object)).toEqual(['subtasks']);
    expect(entries[0].payload).toEqual({ subtasks: next });
    expect(m.task('t1')).toMatchObject({ subtasks: next, completed: false, pendingSync: true });
    expect((await storedTasks())[0].subtasks).toEqual(next); // durable, not just rendered
    expect(m.bridge.requestSync).toHaveBeenCalledTimes(online ? 1 : 0);
  });

  it('checking the last subtask does NOT complete the parent and awards nothing', async () => {
    const t = makeTask({ _id: 't1', subtasks: [sub('a', true), sub('b')] });
    const m = await setup([t], online);

    await act(() => m.result.current.hook.toggleSubtask('t1', 'b'));

    expect(m.task('t1').completed).toBe(false);
    expect(await queuedEntries()).toEqual([expect.objectContaining({ type: 'update' })]);
    expect(m.status.preview).not.toHaveBeenCalled();
  });

  it('un-checking works the same way (it sets the opposite state)', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], online);
    await act(() => m.result.current.hook.toggleSubtask('t1', 'b'));
    expect(m.task('t1').subtasks).toEqual([sub('a'), sub('b'), sub('c')]);
  });

  it('an unknown task id or subtask id does nothing: nothing queued, no state change', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], online);
    await act(() => m.result.current.hook.toggleSubtask('nope', 'a'));
    await act(() => m.result.current.hook.toggleSubtask('t1', 'zzz'));
    expect(await queuedEntries()).toEqual([]);
    expect(m.task('t1').subtasks).toEqual(checklist());
  });

  it('a task without the field (cached before it existed) is a no-op, not a crash', async () => {
    const m = await setup([makeTask({ _id: 'old' })], online);
    await act(() => m.result.current.hook.toggleSubtask('old', 'a'));
    expect(await queuedEntries()).toEqual([]);
    expect(m.task('old')).not.toHaveProperty('subtasks');
  });

  it('two taps awaited one after the other each build on the previous result; the queue holds ONE merged update with the latest list', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], online);
    await act(async () => {
      await m.result.current.hook.toggleSubtask('t1', 'a');
      await m.result.current.hook.toggleSubtask('t1', 'c');
    });
    const expected = [sub('a', true), sub('b', true), sub('c', true)];
    expect(m.task('t1').subtasks).toEqual(expected);
    expect(await queuedEntries()).toEqual([expect.objectContaining({ payload: { subtasks: expected } })]);
  });

  it('two taps fired in the same tick are BOTH applied: the second derives from the stored result of the first (A is never lost)', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], online);
    await act(async () => {
      await Promise.all([m.result.current.hook.toggleSubtask('t1', 'a'), m.result.current.hook.toggleSubtask('t1', 'c')]);
    });
    expect(m.task('t1').subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
    expect((await storedTasks())[0].subtasks).toEqual([sub('a', true), sub('b', true), sub('c', true)]);
  });

  it('toggling the same subtask twice quickly ends where it started', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], online);
    await act(async () => {
      await Promise.all([m.result.current.hook.toggleSubtask('t1', 'a'), m.result.current.hook.toggleSubtask('t1', 'a')]);
    });
    expect(m.task('t1').subtasks).toEqual(checklist());
  });

  it('a task created offline (local id) can have its checklist toggled; the change merges into its queued create', async () => {
    const m = await setup([makeTask({ _id: 'local-1', subtasks: checklist() })], online);
    const { enqueueSyncAction } = await import('../offline/syncQueue');
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'x', subtasks: checklist() } });
    await act(() => m.result.current.hook.toggleSubtask('local-1', 'a'));
    const entries = await queuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ type: 'create', taskId: 'local-1', payload: { subtasks: [sub('a', true), sub('b', true), sub('c')] } });
  });
});

describe('a failed commit stores nothing', () => {
  it('the task keeps its checklist and its pending flag, the queue is empty, and the user is told', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    const { offlineDb } = await import('../offline/db');
    const spy = vi.spyOn(offlineDb, 'transaction').mockRejectedValueOnce(new Error('quota'));

    await act(() => m.result.current.hook.toggleSubtask('t1', 'a'));
    spy.mockRestore();

    expect(m.task('t1').subtasks).toEqual(checklist());
    expect(m.task('t1').pendingSync).toBeFalsy();
    expect(await queuedEntries()).toEqual([]);
    expect(m.status.error).toHaveBeenCalledWith(expect.stringMatching(/storage unavailable/));
  });
});

describe('copy-selected with description and subtasks', () => {
  const copy = async (tasks: Task[]) => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const m = await setup(tasks, true);
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
