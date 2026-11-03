import { describe, expect, it } from 'vitest';
import {
  MAX_SUBTASKS,
  getSubtasks,
  newSubtaskId,
  normalizeSubtasks,
  prepareSubtasks,
  sameSubtasks,
  subtaskCopyLines,
  subtaskProgress,
  validateSubtasks,
  withSubtaskCompleted,
} from './subtasks';

// Issue #15 D4/D8: the pure client helpers. Nothing here touches the network, storage or React.

const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `step ${id}`, completed: false, ...extra });

describe('getSubtasks / subtaskProgress', () => {
  it.each([['undefined', undefined], ['null', null], ['a string', 'x'], ['an object', {}]])('%s reads as an empty list', (_l, value) => {
    expect(getSubtasks({ subtasks: value as never })).toEqual([]);
    expect(subtaskProgress({ subtasks: value as never })).toEqual({ done: 0, total: 0 });
  });

  it('counts done and total, derived from the list', () => {
    expect(subtaskProgress({ subtasks: [sub('a', { completed: true }), sub('b'), sub('c', { completed: true })] })).toEqual({ done: 2, total: 3 });
  });
});

describe('normalizeSubtasks (save path)', () => {
  it('missing, null and non-array values are []', () => {
    for (const raw of [undefined, null, 'x', 5, {}]) expect(normalizeSubtasks(raw)).toEqual([]);
  });

  it('trims titles, drops blank ones, and keeps existing ids and order exactly', () => {
    const out = normalizeSubtasks([sub('b', { title: '  Pack bag ' }), sub('x', { title: '   ' }), sub('a', { completed: true })]);
    expect(out).toEqual([{ id: 'b', title: 'Pack bag', completed: false }, { id: 'a', title: 'step a', completed: true }]);
  });

  it('never generates an id and never re-ids: an entry without a usable id is dropped, not repaired', () => {
    const out = normalizeSubtasks([{ title: 't', completed: false }, sub('bad id'), sub('ok')]);
    expect(out.map((s) => s.id)).toEqual(['ok']);
  });

  it('drops entries of the wrong shape and strips unknown keys', () => {
    const out = normalizeSubtasks([null, 'x', sub('a', { completed: 'yes' }), sub('b', { extra: 1 })]);
    expect(out).toEqual([{ id: 'b', title: 'step b', completed: false }]);
  });

  it('does not de-duplicate (validateSubtasks refuses duplicates instead)', () => {
    expect(normalizeSubtasks([sub('a'), sub('a')])).toHaveLength(2);
  });
});

describe('validateSubtasks', () => {
  it(`allows ${MAX_SUBTASKS} and refuses ${MAX_SUBTASKS + 1}`, () => {
    const make = (n: number) => Array.from({ length: n }, (_, i) => sub(`s${i}`));
    expect(validateSubtasks(make(MAX_SUBTASKS))).toBeNull();
    expect(validateSubtasks(make(MAX_SUBTASKS + 1))).toMatch(/at most 20/);
  });

  it('refuses duplicate ids and over-long titles; accepts duplicate titles', () => {
    expect(validateSubtasks([sub('a'), sub('a')])).toMatch(/unique/);
    expect(validateSubtasks([sub('a', { title: 'x'.repeat(201) })])).toMatch(/200/);
    expect(validateSubtasks([sub('a', { title: 'same' }), sub('b', { title: 'same' })])).toBeNull();
  });
});

describe('withSubtaskCompleted', () => {
  const list = [sub('a'), sub('b'), sub('c')];

  it('sets exactly one subtask, returns a new array, and leaves the others (and the input) alone', () => {
    const out = withSubtaskCompleted(list, 'b', true)!;
    expect(out.map((s) => s.completed)).toEqual([false, true, false]);
    expect(out).not.toBe(list);
    expect(list.every((s) => !s.completed)).toBe(true);
    expect(out[0]).toBe(list[0]);
  });

  it('an unknown id returns null (nothing changes)', () => {
    expect(withSubtaskCompleted(list, 'zzz', true)).toBeNull();
  });

  it('is idempotent: applying it twice equals applying it once', () => {
    const once = withSubtaskCompleted(list, 'a', true)!;
    expect(sameSubtasks(withSubtaskCompleted(once, 'a', true)!, once)).toBe(true);
  });
});

describe('subtaskCopyLines / newSubtaskId / sameSubtasks', () => {
  it('writes [x] and [ ] lines in order, and nothing for no subtasks', () => {
    expect(subtaskCopyLines({ subtasks: [sub('a', { completed: true }), sub('b')] })).toEqual(['  [x] step a', '  [ ] step b']);
    expect(subtaskCopyLines({})).toEqual([]);
  });

  it('ids are unique and match the server pattern', () => {
    const ids = new Set(Array.from({ length: 200 }, newSubtaskId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
  });

  it('sameSubtasks compares id, title, state and order', () => {
    expect(sameSubtasks([sub('a')], [sub('a')])).toBe(true);
    expect(sameSubtasks([sub('a')], [sub('a', { completed: true })])).toBe(false);
    expect(sameSubtasks([sub('a'), sub('b')], [sub('b'), sub('a')])).toBe(false);
  });
});

describe('prepareSubtasks (the save gate: refuses, does not repair)', () => {
  const ok = (raw: unknown) => {
    const result = prepareSubtasks(raw);
    if (!result.ok) throw new Error(result.message);
    return result.subtasks;
  };
  const refusal = (raw: unknown) => {
    const result = prepareSubtasks(raw);
    if (result.ok) throw new Error('expected a refusal');
    return result.message;
  };

  it('keeps ids and order, trims titles, and drops only well-formed blank rows', () => {
    expect(ok([sub('b', { title: ' Pack ' }), sub('x', { title: '   ' }), sub('a', { completed: true })])).toEqual([
      { id: 'b', title: 'Pack', completed: false },
      { id: 'a', title: 'step a', completed: true },
    ]);
    expect(ok([])).toEqual([]);
  });

  it('refuses an entry that is not valid, even with a non-blank title, instead of silently dropping it', () => {
    expect(refusal([sub('a'), { title: 'real', completed: false }])).toMatch(/Subtask 2 is not valid/);
    expect(refusal([sub('bad id')])).toMatch(/Subtask 1/);
    expect(refusal([sub('a', { completed: 'yes' })])).toMatch(/not valid/);
    expect(refusal([null])).toMatch(/not valid/);
    expect(refusal('nope')).toMatch(/must be a list/);
  });

  it('refuses duplicate ids, including one hidden behind a blank row', () => {
    expect(refusal([sub('a'), sub('a')])).toMatch(/unique/);
    expect(refusal([sub('a'), sub('a', { title: '   ' })])).toMatch(/unique/);
  });

  it('enforces the cap on what is kept (blank rows do not count) and the title length', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => sub(`s${i}`));
    expect(ok([...many(MAX_SUBTASKS), sub('blank', { title: ' ' })])).toHaveLength(MAX_SUBTASKS);
    expect(refusal(many(MAX_SUBTASKS + 1))).toMatch(/at most 20/);
    expect(refusal([sub('a', { title: 'x'.repeat(201) })])).toMatch(/200/);
  });

  it('never generates an id and never changes an existing one', () => {
    expect(ok([sub('keep-me_1')]).map((s) => s.id)).toEqual(['keep-me_1']);
  });
});
