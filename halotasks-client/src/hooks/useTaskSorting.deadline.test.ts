import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { inTimeZone, makeTask, TIME_ZONES } from '../test/taskFactory';
import { useTaskSorting } from './useTaskSorting';

const day = (d: string) => `${d}T00:00:00.000Z`;
const ids = (tasks: { _id: string }[]) => tasks.map((t) => t._id);

describe('sorting by due date uses the exact deadline (Issue #10)', () => {
  const tasks = () => [
    makeTask({ _id: 'none-1' }),
    makeTask({ _id: 'd21-0800', dueDate: day('2026-10-21'), dueTime: '08:00' }),
    makeTask({ _id: 'd20-only', dueDate: day('2026-10-20') }),
    makeTask({ _id: 'd20-0900', dueDate: day('2026-10-20'), dueTime: '09:00' }),
    makeTask({ _id: 'd19-only', dueDate: day('2026-10-19') }),
    makeTask({ _id: 'd20-1700', dueDate: day('2026-10-20'), dueTime: '17:00' }),
    makeTask({ _id: 'none-2' }),
  ];

  it('dueSoonest: by day then time; a date-only task follows the timed tasks of its day; undated tasks last', () => {
    const { result } = renderHook(() => useTaskSorting(tasks(), 'dueSoonest'));
    expect(ids(result.current)).toEqual(['d19-only', 'd20-0900', 'd20-1700', 'd20-only', 'd21-0800', 'none-1', 'none-2']);
  });

  it('dueLatest: the reverse order, undated tasks still last', () => {
    const { result } = renderHook(() => useTaskSorting(tasks(), 'dueLatest'));
    expect(ids(result.current)).toEqual(['d21-0800', 'd20-only', 'd20-1700', 'd20-0900', 'd19-only', 'none-1', 'none-2']);
  });

  it.each(TIME_ZONES)('is the same order in %s', (tz) => {
    inTimeZone(tz, () => {
      const { result } = renderHook(() => useTaskSorting(tasks(), 'dueSoonest'));
      expect(ids(result.current)).toEqual(['d19-only', 'd20-0900', 'd20-1700', 'd20-only', 'd21-0800', 'none-1', 'none-2']);
    });
  });

  it('date-only tasks keep their established order: by day, ties stable', () => {
    const input = [
      makeTask({ _id: 'b', dueDate: day('2026-10-22') }),
      makeTask({ _id: 'a1', dueDate: day('2026-10-20') }),
      makeTask({ _id: 'a2', dueDate: day('2026-10-20') }),
    ];
    const { result } = renderHook(() => useTaskSorting(input, 'dueSoonest'));
    expect(ids(result.current)).toEqual(['a1', 'a2', 'b']);
  });

  it('a task with an unparseable due date is treated as having none', () => {
    const input = [makeTask({ _id: 'bad', dueDate: 'garbage' }), makeTask({ _id: 'ok', dueDate: day('2026-10-20') })];
    const { result } = renderHook(() => useTaskSorting(input, 'dueSoonest'));
    expect(ids(result.current)).toEqual(['ok', 'bad']);
  });

  it('does not mutate its input', () => {
    const input = tasks();
    const before = ids(input);
    renderHook(() => useTaskSorting(input, 'dueSoonest'));
    expect(ids(input)).toEqual(before);
  });
});
