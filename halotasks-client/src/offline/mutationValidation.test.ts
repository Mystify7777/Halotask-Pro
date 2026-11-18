import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/taskFactory';
import {
  assertNewLocalId,
  MutationRejectedError,
  newLocalTaskId,
  requireTask,
  validateTaskFields,
} from './mutationValidation';

const valid = { title: 'Write report', priority: 'medium' };

describe('validateTaskFields', () => {
  it('accepts a valid create and a valid partial update', () => {
    expect(validateTaskFields(valid, 'create')).toBeNull();
    expect(validateTaskFields({ priority: 'high' }, 'update')).toBeNull();
    expect(validateTaskFields({}, 'update')).toBeNull();
  });

  it('refuses an empty, blank, missing or over-long title', () => {
    expect(validateTaskFields({ ...valid, title: '   ' }, 'create')).toMatch(/title/);
    expect(validateTaskFields({ priority: 'low' }, 'create')).toMatch(/title/);
    expect(validateTaskFields({ ...valid, title: 'x'.repeat(201) }, 'create')).toMatch(/200/);
    expect(validateTaskFields({ title: ' ' }, 'update')).toMatch(/title/);
  });

  it('refuses an unsupported priority', () => {
    expect(validateTaskFields({ ...valid, priority: 'urgent' }, 'create')).toMatch(/Priority/);
    expect(validateTaskFields({ priority: 'urgent' }, 'update')).toMatch(/Priority/);
  });

  it('refuses malformed tags, description and estimate', () => {
    expect(validateTaskFields({ ...valid, tags: ['ok', 3] }, 'create')).toMatch(/Tags/);
    expect(validateTaskFields({ ...valid, description: 5 }, 'create')).toMatch(/description/);
    expect(validateTaskFields({ ...valid, estimatedMinutes: -1 }, 'create')).toMatch(/estimate/);
    expect(validateTaskFields({ ...valid, estimatedMinutes: Number.NaN }, 'create')).toMatch(/estimate/);
    expect(validateTaskFields({ ...valid, estimatedMinutes: 0 }, 'create')).toBeNull();
  });

  it('keeps a due time next to a due date, and only an explicit clearing of the date contradicts it', () => {
    expect(validateTaskFields({ ...valid, dueTime: '09:30' }, 'create')).toMatch(/due date/);
    expect(validateTaskFields({ ...valid, dueDate: '2026-10-20T00:00:00.000Z', dueTime: '09:30' }, 'create')).toBeNull();
    expect(validateTaskFields({ dueTime: '09:30' }, 'update')).toBeNull(); // the stored date applies
    expect(validateTaskFields({ dueDate: null, dueTime: '09:30' }, 'update')).toMatch(/due date/);
    expect(validateTaskFields({ dueDate: null, dueTime: null }, 'update')).toBeNull();
    expect(validateTaskFields({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '25:61' }, 'update')).toMatch(/09:30/);
  });
});

describe('task presence and local ids', () => {
  it('requireTask returns the stored task or refuses with TASK_NOT_FOUND', () => {
    const task = makeTask({ _id: 'a' });
    expect(requireTask([task], 'a')).toBe(task);
    expect(() => requireTask([task], 'b')).toThrow(MutationRejectedError);
    try {
      requireTask([], 'b');
    } catch (error) {
      expect((error as MutationRejectedError).code).toBe('TASK_NOT_FOUND');
    }
  });

  it('local ids are local- plus a UUID and do not repeat', () => {
    const ids = new Set(Array.from({ length: 200 }, newLocalTaskId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^local-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('a colliding local id is refused', () => {
    const task = makeTask({ _id: 'local-1' });
    expect(() => assertNewLocalId([task], 'local-1')).toThrow(MutationRejectedError);
    expect(() => assertNewLocalId([task], 'local-2')).not.toThrow();
  });
});
