import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/taskFactory';
import { applyUpdatePayload, baseForDelta, captureBase, describeConflict, keepMineEdit, mergeBase, taskValue, type ConflictedMutation } from './conflicts';

// Issue #62B: the pure rules. The queue and processor behaviour built on them is in conflicts.realdb.test.ts.

describe('captureBase', () => {
  const task = makeTask({ title: 'A', priority: 'low', tags: ['x'], dueDate: '2026-11-01T00:00:00.000Z', description: '' });

  it('holds the stored value of each field the payload CHANGES', () => {
    expect(captureBase(task, { title: 'B', priority: 'high' })).toEqual({ title: 'A', priority: 'low' });
  });

  it('leaves out a field the payload only repeats (the edit form sends every field every time)', () => {
    expect(captureBase(task, { title: 'B', priority: 'low', tags: ['x'], dueDate: '2026-11-01T00:00:00.000Z', description: '' })).toEqual({ title: 'A' });
  });

  it('dates are compared as instants, whatever form they are written in', () => {
    expect(captureBase(task, { dueDate: '2026-11-01T05:30:00+05:30' })).toEqual({});
    expect(captureBase(task, { dueDate: '2026-11-02' })).toEqual({ dueDate: '2026-11-01T00:00:00.000Z' });
  });

  it('an absent optional field has the base null; clearing a present one is a change', () => {
    expect(captureBase(task, { startTime: '2026-11-01T09:00:00Z' })).toEqual({ startTime: null });
    expect(captureBase(task, { dueDate: null })).toEqual({ dueDate: '2026-11-01T00:00:00.000Z' });
    expect(captureBase(task, { startTime: null })).toEqual({}); // already absent
  });

  it('lists are one field: a changed list has the whole old list as its base, an equal one has none', () => {
    expect(captureBase(task, { tags: ['x', 'y'] })).toEqual({ tags: ['x'] });
    expect(captureBase(task, { tags: ['x'] })).toEqual({});
    const withSubtasks = makeTask({ subtasks: [{ id: 's1', title: 'One', completed: false }] });
    expect(captureBase(withSubtasks, { subtasks: [] })).toEqual({ subtasks: [{ id: 's1', title: 'One', completed: false }] });
    expect(captureBase(makeTask({}), { subtasks: [] })).toEqual({}); // a task without the field reads as []
  });

  it('defaults are filled in like the server does', () => {
    const bare = { ...makeTask({}), description: undefined, priority: undefined, estimatedMinutes: undefined, reminderSent: undefined } as never;
    expect(captureBase(bare, { description: 'd', priority: 'high', estimatedMinutes: 5, reminderSent: true })).toEqual({ description: '', priority: 'medium', estimatedMinutes: 0, reminderSent: false });
  });

  it('never covers completion fields or unknown keys', () => {
    expect(captureBase(task, { completed: true, completionEvent: {}, nonsense: 1 })).toEqual({});
  });

  it('no task or no payload: no base', () => {
    expect(captureBase(undefined, { title: 'x' })).toEqual({});
    expect(captureBase(task, undefined)).toEqual({});
  });
});

describe('mergeBase (D11: the earlier base wins)', () => {
  it('keeps the earlier base for a field it holds and adds the new base for a field it does not', () => {
    expect(mergeBase({ title: 'A' }, { title: 'B', priority: 'low' })).toEqual({ title: 'A', priority: 'low' });
  });
  it('an entry without a base stays without one (its stored values may already be local edits)', () => {
    expect(mergeBase(undefined, { title: 'B' })).toBeUndefined();
  });
  it('only a resolution replaces', () => {
    expect(mergeBase({ title: 'A', priority: 'low' }, { title: 'Z' }, true)).toEqual({ title: 'Z', priority: 'low' });
    expect(mergeBase(undefined, { title: 'Z' }, true)).toEqual({ title: 'Z' });
  });
});

describe('baseForDelta', () => {
  it('takes each field from the first source that has it, only for the fields of the delta', () => {
    expect(baseForDelta({ title: 'C', tags: ['t'] }, { title: 'B' }, { title: 'A', tags: [] })).toEqual({ title: 'B', tags: [] });
  });
  it('a field no source knows has no base; no sources at all means no base', () => {
    expect(baseForDelta({ priority: 'high' }, { title: 'B' }, { title: 'A' })).toEqual({});
    expect(baseForDelta({ priority: 'high' }, undefined, undefined)).toBeUndefined();
  });
  it('ignores fields that cannot be checked', () => {
    expect(baseForDelta({ completed: true }, { completed: false } as never)).toEqual({});
  });
});

describe('keepMineEdit', () => {
  const conflict: ConflictedMutation = {
    taskId: 't1',
    title: 'Plan',
    fields: [{ field: 'title', base: 'A', requested: 'Mine', current: 'Theirs' }],
    mine: { title: 'Mine', priority: 'high' },
    base: { title: 'A', priority: 'low' },
  };
  it('re-sends everything that was discarded, based on what the server holds now for the conflicted fields', () => {
    expect(keepMineEdit(conflict)).toEqual({ payload: { title: 'Mine', priority: 'high' }, base: { title: 'Theirs', priority: 'low' } });
  });
  it('does not share state with the notice', () => {
    const edit = keepMineEdit(conflict);
    edit.payload.title = 'changed';
    expect(conflict.mine.title).toBe('Mine');
  });
});

describe('applyUpdatePayload and taskValue', () => {
  it('clearing an optional field removes it; everything else is set', () => {
    const task = makeTask({ dueDate: '2026-11-01T00:00:00.000Z', dueTime: '09:00' });
    const next = applyUpdatePayload(task, { title: 'New', dueDate: null, dueTime: null });
    expect(next.title).toBe('New');
    expect('dueDate' in next).toBe(false);
    expect('dueTime' in next).toBe(false);
  });
  it('subtasks are compared on id, title and completed only', () => {
    const task = makeTask({ subtasks: [{ id: 's', title: 'T', completed: true, extra: 1 } as never] });
    expect(taskValue(task, 'subtasks')).toEqual([{ id: 's', title: 'T', completed: true }]);
  });
});

describe('describeConflict', () => {
  const base = { taskId: 't', title: 'Buy milk', mine: {}, base: {} };
  it('says what was not saved, what differs, and never offers a merge', () => {
    const text = describeConflict({ ...base, fields: [{ field: 'priority', base: 'low', requested: 'high', current: 'medium' }] });
    expect(text).toBe('“Buy milk” was changed on another device, so your edit was not saved (priority: yours “high”, now “medium”).');
  });
  it('shortens long values, summarises lists and dates, and caps the fields listed', () => {
    const text = describeConflict({
      ...base,
      title: null,
      fields: [
        { field: 'title', base: 'a', requested: 'x'.repeat(50), current: 'b' },
        { field: 'tags', base: [], requested: ['a', 'b'], current: ['a'] },
        { field: 'dueDate', base: null, requested: '2026-11-05T00:00:00.000Z', current: null },
        { field: 'estimatedMinutes', base: 0, requested: 5, current: 9 },
      ],
    }, 'Fallback');
    expect(text).toContain('“Fallback”');
    expect(text).toContain(`yours “${'x'.repeat(29)}…”`);
    expect(text).toContain('tags: yours 2 tags, now 1 tag');
    expect(text).toContain('due date: yours 2026-11-05, now none');
    expect(text).toContain('and 1 more');
  });
});
