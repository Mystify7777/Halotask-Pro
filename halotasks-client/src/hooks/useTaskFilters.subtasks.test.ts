import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { useTaskFilters } from './useTaskFilters';

// Issue #15 D(4): search extends the existing predicate with subtask TITLES, and nothing else about subtasks.

const search = (tasks: Task[], text: string) =>
  renderHook(() => useTaskFilters({ tasks, search: text, filterMode: 'all', priorityFilter: 'all', tagFilter: null })).result.current.map((t) => t._id);

const withSubs = makeTask({
  _id: 'with',
  title: 'Trip',
  subtasks: [
    { id: 'passport-id', title: 'Renew Passport', completed: true },
    { id: 'b', title: 'Book hotel', completed: false },
  ],
});
const plain = makeTask({ _id: 'plain', title: 'Groceries', description: 'milk' });
const legacy = makeTask({ _id: 'legacy', title: 'Old' });
delete (legacy as { subtasks?: unknown }).subtasks;
const empty = makeTask({ _id: 'empty', title: 'Empty', subtasks: [] });
const all = [withSubs, plain, legacy, empty];

describe('search over subtasks', () => {
  it('matches a subtask title, case-insensitively', () => {
    expect(search(all, 'passport')).toEqual(['with']);
    expect(search(all, 'BOOK HOTEL')).toEqual(['with']);
  });

  it('still matches the title and the description as before', () => {
    expect(search(all, 'groc')).toEqual(['plain']);
    expect(search(all, 'milk')).toEqual(['plain']);
  });

  it('never matches a subtask id or its completion state', () => {
    expect(search(all, 'passport-id')).toEqual([]);
    expect(search(all, 'true')).toEqual([]);
    expect(search(all, 'completed')).toEqual([]);
  });

  it('tasks with a missing (legacy) or empty list do not break search and match only on their own text', () => {
    expect(search(all, 'old')).toEqual(['legacy']);
    expect(search(all, 'empty')).toEqual(['empty']);
    expect(search(all, 'zzz')).toEqual([]);
  });

  it('an empty search returns every task', () => {
    expect(search(all, '  ')).toHaveLength(4);
  });
});
