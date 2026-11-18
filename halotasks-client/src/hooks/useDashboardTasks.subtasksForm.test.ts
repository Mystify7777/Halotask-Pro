import { act } from '@testing-library/react';
import type { FormEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { mountTasks, queuedEntries } from '../test/dashboardTasksHarness';
import type { Subtask, Task, TaskCreatePayload } from '../types/task';

// Issue #15 (phase 3) + Issue #57: what the create and edit forms turn into in the queue and in local state. Every mutation
// is local-first: the queue entry is what will be sent, committed together with the task. The offline layer is real
// (fake-indexeddb); only the sync drain is a double.

vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));

const submit = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
const sub = (id: string, extra: Partial<Subtask> = {}): Subtask => ({ id, title: `step ${id}`, completed: false, ...extra });
const checklist = () => [sub('a'), sub('b', { completed: true }), sub('c')];

const setup = async (initial: Task[], isOnline: boolean) => {
  const view = await mountTasks(initial, isOnline);
  return Object.assign(view, {
    status: { error: view.setStatusError, info: view.setStatusInfo },
    task: (id: string) => view.result.current.tasks.find((t) => t._id === id)!,
    h: () => view.result.current.hook,
  });
};

const sentUpdate = async () => {
  const updates = (await queuedEntries()).filter((entry) => entry.type === 'update');
  return updates[updates.length - 1].payload as Record<string, unknown>;
};
const sentCreates = async () => (await queuedEntries()).filter((entry) => entry.type === 'create').map((entry) => entry.payload as TaskCreatePayload);

const edit = async (m: Awaited<ReturnType<typeof setup>>, id: string, change: (subtasks: Subtask[]) => Subtask[] | undefined) => {
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
const save = (m: Awaited<ReturnType<typeof setup>>, id: string) => act(() => m.h().handleSaveTaskEdit(id));

beforeEach(() => vi.clearAllMocks());

describe('create form', () => {
  it('sends the description and subtasks only when filled in; they stay optional', async () => {
    const m = await setup([], true);
    act(() => m.h().setTitle('Plain'));
    await act(() => m.h().handleCreateTask(submit));
    const plain = (await sentCreates())[0];
    expect(plain).not.toHaveProperty('description', expect.anything());
    expect(plain.subtasks).toBeUndefined();

    act(() => m.h().setTitle('Rich'));
    act(() => m.h().setDescription('  some notes  '));
    act(() => m.h().setCreateSubtasks([sub('x'), sub('blank', { title: '  ' }), sub('y', { title: ' Pack ' })]));
    await act(() => m.h().handleCreateTask(submit));
    const rich = (await sentCreates())[1];
    expect(rich.description).toBe('some notes');
    expect(rich.subtasks).toEqual([sub('x'), { id: 'y', title: 'Pack', completed: false }]);
  });

  it('clears the description and checklist after a successful create', async () => {
    const m = await setup([], true);
    act(() => m.h().setTitle('t'));
    act(() => m.h().setDescription('d'));
    act(() => m.h().setCreateSubtasks([sub('x')]));
    await act(() => m.h().handleCreateTask(submit));
    expect(m.h().description).toBe('');
    expect(m.h().createSubtasks).toEqual([]);
  });

  it('a refused checklist sends nothing, queues nothing, adds nothing, and keeps what was typed', async () => {
    const m = await setup([], true);
    act(() => m.h().setTitle('Keep me'));
    act(() => m.h().setDescription('keep this too'));
    const invalid = Array.from({ length: 21 }, (_, i) => sub(`s${i}`));
    act(() => m.h().setCreateSubtasks(invalid));

    await act(() => m.h().handleCreateTask(submit));

    expect(await queuedEntries()).toEqual([]);
    expect(m.result.current.tasks).toHaveLength(0);
    expect(m.h().createSubtasksError).toMatch(/at most 20/);
    expect(m.h().title).toBe('Keep me');
    expect(m.h().description).toBe('keep this too');
    expect(m.h().createSubtasks).toEqual(invalid);

    act(() => m.h().setCreateSubtasks([sub('ok')])); // editing clears the message
    expect(m.h().createSubtasksError).toBeNull();
  });

  it('offline: the task is committed locally and queued with the description and subtasks', async () => {
    const m = await setup([], false);
    act(() => m.h().setTitle('Offline'));
    act(() => m.h().setDescription('notes'));
    act(() => m.h().setCreateSubtasks([sub('x'), sub('y')]));

    await act(() => m.h().handleCreateTask(submit));

    expect(await queuedEntries()).toEqual([expect.objectContaining({ type: 'create', payload: expect.objectContaining({ description: 'notes', subtasks: [sub('x'), sub('y')] }) })]);
    expect(m.result.current.tasks[0]).toMatchObject({ description: 'notes', subtasks: [sub('x'), sub('y')] });
  });
});

describe('edit form: payload correctness', () => {
  it('opening and saving without touching them omits both fields entirely', async () => {
    const m = await setup([makeTask({ _id: 't1', description: 'orig', subtasks: checklist() })], true);
    await edit(m, 't1', () => undefined as never);
    await save(m, 't1');
    expect((await sentUpdate())).not.toHaveProperty('subtasks');
    expect((await sentUpdate())).not.toHaveProperty('description');
  });

  it('an unrelated change (the title) still omits both', async () => {
    const m = await setup([makeTask({ _id: 't1', description: 'orig', subtasks: checklist() })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, title: 'Renamed' })));
    await save(m, 't1');
    expect((await sentUpdate()).title).toBe('Renamed');
    expect((await sentUpdate())).not.toHaveProperty('subtasks');
    expect((await sentUpdate())).not.toHaveProperty('description');
  });

  it('a changed list is sent whole, with untouched ids; an added row gets the id it was created with', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    await edit(m, 't1', (s) => [{ ...s[0], title: 'renamed a' }, s[1], s[2], sub('new-1', { title: 'added' })]);
    await save(m, 't1');
    expect((await sentUpdate()).subtasks).toEqual([sub('a', { title: 'renamed a' }), sub('b', { completed: true }), sub('c'), sub('new-1', { title: 'added' })]);
  });

  it('removing a row sends the shorter list; removing all sends []', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    await edit(m, 't1', () => []);
    await save(m, 't1');
    expect((await sentUpdate()).subtasks).toEqual([]);
  });

  it('changing the list and then restoring its original contents omits it (compared by id, title, state, not by reference)', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: [...c!.subtasks!, sub('tmp', { title: 'temp' })] })));
    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: checklist() }))); // a different array, same contents
    await save(m, 't1');
    expect((await sentUpdate())).not.toHaveProperty('subtasks');
  });

  it('an added row that is left blank counts as no change (blank rows are dropped, then compared)', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    await edit(m, 't1', (s) => [...s, sub('blank', { title: '   ' })]);
    await save(m, 't1');
    expect((await sentUpdate())).not.toHaveProperty('subtasks');
  });

  it('the opening snapshot cannot be altered through the form state', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    // mutate the form's own objects in place, the way a careless handler could
    act(() => m.h().setEditState((c) => { c!.subtasks![0].title = 'mutated in place'; return { ...c!, subtasks: [...c!.subtasks!] }; }));
    await save(m, 't1');
    expect((await sentUpdate()).subtasks).toEqual([sub('a', { title: 'mutated in place' }), sub('b', { completed: true }), sub('c')]); // seen as changed
    expect(m.task('t1').subtasks).toBeDefined();
  });

  it('a description change is sent trimmed; clearing it sends an empty string; unchanged is omitted', async () => {
    const m = await setup([makeTask({ _id: 't1', description: 'orig' })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, description: '  new text ' })));
    await save(m, 't1');
    expect((await sentUpdate()).description).toBe('new text');

    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, description: '' })));
    await save(m, 't1');
    expect((await sentUpdate()).description).toBe('');
  });
});

describe('edit form: lost-update protection', () => {
  it.each([true, false])('online=%s: a checkbox toggled after the sheet opened survives an unrelated edit; the queued update carries both', async (online) => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], online);
    act(() => m.h().handleStartEditing(m.task('t1')));
    await act(() => m.h().toggleSubtask('t1', 'a')); // toggled elsewhere while the sheet is open
    expect(m.task('t1').subtasks![0].completed).toBe(true);

    act(() => m.h().setEditState((c) => ({ ...c!, title: 'Renamed' })));
    await save(m, 't1');

    // The edit itself names no checklist (it was not changed in the form), so it cannot revert the toggle: the single
    // queued update is the toggle's list merged with the rename.
    const entries = await queuedEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].payload).toMatchObject({ title: 'Renamed', subtasks: [sub('a', { completed: true }), sub('b', { completed: true }), sub('c')] });
    expect(m.task('t1').subtasks![0].completed).toBe(true);
    expect(m.task('t1').title).toBe('Renamed');
  });

  it('when the list WAS changed, a completion toggled since the sheet opened is kept, not reverted by the stale form', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], false);
    act(() => m.h().handleStartEditing(m.task('t1')));
    await act(() => m.h().toggleSubtask('t1', 'c')); // c -> true elsewhere

    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: [...c!.subtasks!, sub('n', { title: 'new' })] })));
    await save(m, 't1');

    const queued = ((await queuedEntries())[0].payload as { subtasks: Subtask[] }).subtasks;
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
  ])('%s: nothing is queued or changed, the message shows, and the form keeps its contents', async (_label, bad) => {
    for (const online of [true, false]) {
      const initial = makeTask({ _id: 't1', title: 'Orig', subtasks: checklist() });
      const m = await setup([initial], online);
      act(() => m.h().handleStartEditing(m.task('t1')));
      act(() => m.h().setEditState((c) => ({ ...c!, title: 'Typed title', subtasks: bad() })));

      await save(m, 't1');

      expect(await queuedEntries()).toEqual([]);
      expect(m.bridge.requestSync).not.toHaveBeenCalled();
      expect(m.task('t1')).toEqual(initial); // no optimistic change
      expect(m.h().editingTaskId).toBe('t1'); // the form stays open
      expect(m.h().editState!.title).toBe('Typed title');
      expect(m.h().editState!.subtasks).toEqual(bad());
      expect(m.h().editState!.saveError).toBeTruthy();
    }
  });

  it('a refused save does not clear the dashboard status messages it never set', async () => {
    const m = await setup([makeTask({ _id: 't1', subtasks: checklist() })], true);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, subtasks: [sub('a'), sub('a')] })));
    await save(m, 't1');
    expect(m.status.info).not.toHaveBeenCalled();
  });
});

describe('edit form: offline', () => {
  it('a changed list and description are applied locally and queued with the update', async () => {
    const m = await setup([makeTask({ _id: 't1', description: 'orig', subtasks: checklist() })], false);
    act(() => m.h().handleStartEditing(m.task('t1')));
    act(() => m.h().setEditState((c) => ({ ...c!, description: 'new', subtasks: [sub('z', { title: 'only' })] })));
    await save(m, 't1');

    expect(m.task('t1')).toMatchObject({ description: 'new', subtasks: [sub('z', { title: 'only' })], pendingSync: true });
    expect((await queuedEntries())[0].payload).toMatchObject({ description: 'new', subtasks: [sub('z', { title: 'only' })] });
  });
});
