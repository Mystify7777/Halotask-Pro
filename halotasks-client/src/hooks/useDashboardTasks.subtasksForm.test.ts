import { act, renderHook } from '@testing-library/react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Subtask, Task } from '../types/task';

// Issue #15 (phase 3): what the create and edit forms turn into on the wire, in the queue and in local state. The HTTP
// service, the offline queue and the cache are doubles: this proves what the hook sends and stores, not what the server does.

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
const sub = (id: string, extra: Partial<Subtask> = {}): Subtask => ({ id, title: `step ${id}`, completed: false, ...extra });
const checklist = () => [sub('a'), sub('b', { completed: true }), sub('c')];

const setup = (initial: Task[], isOnline: boolean) => {
  const status = { error: vi.fn(), info: vi.fn() };
  const view = renderHook(() => {
    const [tasks, setTasks] = useState<Task[]>(initial);
    const hook = useDashboardTasks({
      tasks,
      setTasks,
      isOnline,
      syncBridgeRef: { current: { setSyncStatus: vi.fn(), refreshPendingQueueCount: vi.fn(async () => 0) } },
      previewGrowthForCompletion: vi.fn(),
      applyServerGrowth: vi.fn(),
      setStatusError: status.error,
      setStatusInfo: status.info,
    });
    return { hook, tasks };
  });
  const api = { ...view, status, task: (id: string) => view.result.current.tasks.find((t) => t._id === id)!, h: () => view.result.current.hook };
  return api;
};

const echo = () =>
  vi.mocked(taskService.updateTask).mockImplementation(async (id, payload) => ({ task: makeTask({ _id: id, ...(payload as Partial<Task>) }) }));
const sentUpdate = () => vi.mocked(taskService.updateTask).mock.calls[0][1] as Record<string, unknown>;

const edit = async (m: ReturnType<typeof setup>, id: string, change: (subtasks: Subtask[]) => Subtask[] | undefined) => {
  act(() => m.h().handleStartEditing(m.task(id)));
  if (change) {
    act(() =>
      m.h().setEditState((current) => {
        const next = change(current!.subtasks!);
        return next ? { ...current!, subtasks: next } : current;
      }),
    );
  }
};
const save = (m: ReturnType<typeof setup>, id: string) => act(() => m.h().handleSaveTaskEdit(id));

beforeEach(() => {
  vi.mocked(taskService.createTask).mockReset();
  vi.mocked(taskService.updateTask).mockReset();
  vi.mocked(enqueueSyncAction).mockReset();
  vi.mocked(enqueueSyncAction).mockResolvedValue([]);
  vi.mocked(taskService.createTask).mockImplementation(async (payload) => ({ task: makeTask({ _id: 'srv-1', ...(payload as Partial<Task>) }) }));
});

describe('create form', () => {
  it('sends the description and subtasks only when filled in; they stay optional', async () => {
    const m = setup([], true);
    act(() => m.h().setTitle('Plain'));
    await act(() => m.h().handleCreateTask(submit));
    const plain = vi.mocked(taskService.createTask).mock.calls[0][0];
    expect(plain).not.toHaveProperty('description', expect.anything());
    expect(plain.subtasks).toBeUndefined();

    act(() => m.h().setTitle('Rich'));
    act(() => m.h().setDescription('  some notes  '));
    act(() => m.h().setCreateSubtasks([sub('x'), sub('blank', { title: '  ' }), sub('y', { title: ' Pack ' })]));
    await act(() => m.h().handleCreateTask(submit));
    const rich = vi.mocked(taskService.createTask).mock.calls[1][0];
    expect(rich.description).toBe('some notes');
    expect(rich.subtasks).toEqual([sub('x'), { id: 'y', title: 'Pack', completed: false }]);
  });

  it('clears the description and checklist after a successful create', async () => {
    const m = setup([], true);
    act(() => m.h().setTitle('t'));
    act(() => m.h().setDescription('d'));
    act(() => m.h().setCreateSubtasks([sub('x')]));
    await act(() => m.h().handleCreateTask(submit));
    expect(m.h().description).toBe('');
    expect(m.h().createSubtasks).toEqual([]);
  });

  it('a refused checklist sends nothing, queues nothing, adds nothing, and keeps what was typed', async () => {
    const m = setup([], true);
    act(() => m.h().setTitle('Keep me'));
    act(() => m.h().setDescription('keep this too'));
    const invalid = Array.from({ length: 21 }, (_, i) => sub(`s${i}`));
    act(() => m.h().setCreateSubtasks(invalid));

    await act(() => m.h().handleCreateTask(submit));

    expect(taskService.createTask).not.toHaveBeenCalled();
    expect(enqueueSyncAction).not.toHaveBeenCalled();
    expect(m.result.current.tasks).toHaveLength(0);
    expect(m.h().createSubtasksError).toMatch(/at most 20/);
    expect(m.h().title).toBe('Keep me');
    expect(m.h().description).toBe('keep this too');
    expect(m.h().createSubtasks).toEqual(invalid);

    act(() => m.h().setCreateSubtasks([sub('ok')])); // editing clears the message
    expect(m.h().createSubtasksError).toBeNull();
  });

  it('offline: the task is created locally and queued with the description and subtasks', async () => {
    const m = setup([], false);
    act(() => m.h().setTitle('Offline'));
    act(() => m.h().setDescription('notes'));
    act(() => m.h().setCreateSubtasks([sub('x'), sub('y')]));

    await act(() => m.h().handleCreateTask(submit));

    expect(enqueueSyncAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'create', payload: expect.objectContaining({ description: 'notes', subtasks: [sub('x'), sub('y')] }) }));
    expect(m.result.current.tasks[0]).toMatchObject({ description: 'notes', subtasks: [sub('x'), sub('y')] });
  });
});

describe('edit form: payload correctness', () => {
  it('opening and saving without touching them omits both fields entirely', async () => {
    const m = setup([makeTask({ _id: 't1', description: 'orig', subtasks: checklist() })], true);
    echo();
    await edit(m, 't1', () => undefined as never);
    await save(m, 't1');
    expect(sentUpdate()).not.toHaveProperty('subtasks');
    expect(sentUpdate()).not.toHaveProperty('description');
  });

  it('an unrelated change (the title) still omits both', async () => {
    const m = setup([makeTask({ _id: 't1', description: 'orig', subtasks: checklist() })], true);
    echo();
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, title: 'Renamed' })));
    await save(m, 't1');
    expect(sentUpdate().title).toBe('Renamed');
    expect(sentUpdate()).not.toHaveProperty('subtasks');
    expect(sentUpdate()).not.toHaveProperty('description');
  });

  it('a changed list is sent whole, with untouched ids; an added row gets the id it was created with', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    echo();
    await edit(m, 't1', (s) => [{ ...s[0], title: 'renamed a' }, s[1], s[2], sub('new-1', { title: 'added' })]);
    await save(m, 't1');
    expect(sentUpdate().subtasks).toEqual([sub('a', { title: 'renamed a' }), sub('b', { completed: true }), sub('c'), sub('new-1', { title: 'added' })]);
  });

  it('removing a row sends the shorter list; removing all sends []', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    echo();
    await edit(m, 't1', () => []);
    await save(m, 't1');
    expect(sentUpdate().subtasks).toEqual([]);
  });

  it('changing the list and then restoring its original contents omits it (compared by id, title, state, not by reference)', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    echo();
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: [...c!.subtasks!, sub('tmp', { title: 'temp' })] })));
    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: checklist() }))); // a different array, same contents
    await save(m, 't1');
    expect(sentUpdate()).not.toHaveProperty('subtasks');
  });

  it('an added row that is left blank counts as no change (blank rows are dropped, then compared)', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    echo();
    await edit(m, 't1', (s) => [...s, sub('blank', { title: '   ' })]);
    await save(m, 't1');
    expect(sentUpdate()).not.toHaveProperty('subtasks');
  });

  it('the opening snapshot cannot be altered through the form state', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    echo();
    act(() => m.h().handleStartEditing(m.task('t1')));
    // mutate the form's own objects in place, the way a careless handler could
    act(() => m.h().setEditState((c) => { c!.subtasks![0].title = 'mutated in place'; return { ...c!, subtasks: [...c!.subtasks!] }; }));
    await save(m, 't1');
    expect(sentUpdate().subtasks).toEqual([sub('a', { title: 'mutated in place' }), sub('b', { completed: true }), sub('c')]); // seen as changed
    expect(m.task('t1').subtasks).toBeDefined();
  });

  it('a description change is sent trimmed; clearing it sends an empty string; unchanged is omitted', async () => {
    const m = setup([makeTask({ _id: 't1', description: 'orig' })], true);
    echo();
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, description: '  new text ' })));
    await save(m, 't1');
    expect(sentUpdate().description).toBe('new text');

    vi.mocked(taskService.updateTask).mockClear();
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, description: '' })));
    await save(m, 't1');
    expect(sentUpdate().description).toBe('');
  });
});

describe('edit form: lost-update protection', () => {
  it('a checkbox toggled after the sheet opened survives an unrelated edit (online)', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    vi.mocked(taskService.updateTask).mockImplementation(async (id, payload) => ({ task: makeTask({ _id: id, subtasks: (payload.subtasks as Subtask[]) ?? [sub('a', { completed: true }), sub('b', { completed: true }), sub('c')] }) }));
    await act(() => m.h().toggleSubtask('t1', 'a')); // toggled elsewhere while the sheet is open
    expect(m.task('t1').subtasks![0].completed).toBe(true);

    vi.mocked(taskService.updateTask).mockClear();
    act(() => m.h().setEditState((c) => ({ ...c!, title: 'Renamed' })));
    await save(m, 't1');

    expect(sentUpdate()).not.toHaveProperty('subtasks'); // so the server's toggled list is untouched
    expect(m.task('t1').subtasks![0].completed).toBe(true);
  });

  it('a checkbox toggled after the sheet opened survives an unrelated edit (offline): the queued update has no subtasks', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    act(() => m.h().handleStartEditing(m.task('t1')));
    await act(() => m.h().toggleSubtask('t1', 'a'));
    vi.mocked(enqueueSyncAction).mockClear();

    act(() => m.h().setEditState((c) => ({ ...c!, title: 'Renamed' })));
    await save(m, 't1');

    const queued = vi.mocked(enqueueSyncAction).mock.calls[0][0].payload as Record<string, unknown>;
    expect(queued).not.toHaveProperty('subtasks');
    expect(m.task('t1').subtasks![0].completed).toBe(true);
    expect(m.task('t1').title).toBe('Renamed');
  });

  it('when the list WAS changed, a completion toggled since the sheet opened is kept, not reverted by the stale form', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    act(() => m.h().handleStartEditing(m.task('t1')));
    await act(() => m.h().toggleSubtask('t1', 'c')); // c -> true elsewhere
    vi.mocked(enqueueSyncAction).mockClear();

    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: [...c!.subtasks!, sub('n', { title: 'new' })] })));
    await save(m, 't1');

    const queued = (vi.mocked(enqueueSyncAction).mock.calls[0][0].payload as { subtasks: Subtask[] }).subtasks;
    expect(queued.find((s) => s.id === 'c')!.completed).toBe(true);
    expect(queued.map((s) => s.id)).toEqual(['a', 'b', 'c', 'n']);
  });
});

describe('edit form: a refused save has no side effects', () => {
  it.each([
    ['more than 20', () => Array.from({ length: 21 }, (_, i) => sub(`s${i}`))],
    ['a duplicate id', () => [sub('a'), sub('a')]],
    ['an over-long title', () => [sub('a', { title: 'x'.repeat(201) })]],
    ['an entry that is not valid', () => [{ title: 'no id', completed: false } as unknown as Subtask]],
  ])('%s: nothing is sent, queued or changed, the message shows, and the form keeps its contents', async (_label, bad) => {
    for (const online of [true, false]) {
      const initial = makeTask({ _id: 't1', title: 'Orig', subtasks: checklist() });
      const m = setup([initial], online);
      act(() => m.h().handleStartEditing(m.task('t1')));
      act(() => m.h().setEditState((c) => ({ ...c!, title: 'Typed title', subtasks: bad() })));
      vi.mocked(taskService.updateTask).mockClear();
      vi.mocked(enqueueSyncAction).mockClear();

      await save(m, 't1');

      expect(taskService.updateTask).not.toHaveBeenCalled();
      expect(enqueueSyncAction).not.toHaveBeenCalled();
      expect(m.task('t1')).toEqual(initial); // no optimistic change
      expect(m.h().editingTaskId).toBe('t1'); // the form stays open
      expect(m.h().editState!.title).toBe('Typed title');
      expect(m.h().editState!.subtasks).toEqual(bad());
      expect(m.h().editState!.saveError).toBeTruthy();
    }
  });

  it('a refused save does not clear the dashboard status messages it never set', async () => {
    const m = setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: [sub('a'), sub('a')] })));
    await save(m, 't1');
    expect(m.status.info).not.toHaveBeenCalled();
  });
});

describe('edit form: offline', () => {
  it('a changed list and description are applied locally and queued with the update', async () => {
    const m = setup([makeTask({ _id: 't1', description: 'orig', subtasks: checklist() })], false);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, description: 'new', subtasks: [sub('z', { title: 'only' })] })));
    await save(m, 't1');

    expect(m.task('t1')).toMatchObject({ description: 'new', subtasks: [sub('z', { title: 'only' })], pendingSync: true });
    expect(vi.mocked(enqueueSyncAction).mock.calls[0][0].payload).toMatchObject({ description: 'new', subtasks: [sub('z', { title: 'only' })] });
  });
});
