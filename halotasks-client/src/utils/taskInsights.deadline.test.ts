import { afterEach, describe, expect, it, vi } from 'vitest';
import { inTimeZone, makeTask, TIME_ZONES } from '../test/taskFactory';
import type { Task } from '../types/task';
import { getDueTodayTasks, getOverdueTasks, getUpcomingTasks } from './taskInsights';

// Smart-section membership (Issue #10). The functions read "now" themselves, so each case pins it.
afterEach(() => vi.useRealTimers());

const at = (y: number, mo: number, d: number, h = 12, mi = 0, s = 0) => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(y, mo - 1, d, h, mi, s));
};

const day = (d: string) => `${d}T00:00:00.000Z`; // how the server returns a due date

const sections = (tasks: Task[]) => ({
  overdue: getOverdueTasks(tasks).map((t) => t._id),
  today: getDueTodayTasks(tasks).map((t) => t._id),
  upcoming: getUpcomingTasks(tasks, Number.MAX_SAFE_INTEGER).map((t) => t._id),
});

/** What section membership was before due times existed: the stored instant read in LOCAL time. */
const legacySections = (tasks: Task[]) => {
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const todayStart = startOfDay(new Date());
  const key = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  const open = tasks.filter((t) => !t.completed && t.dueDate);
  return {
    overdue: open.filter((t) => startOfDay(new Date(t.dueDate!)) < todayStart).map((t) => t._id),
    today: open.filter((t) => key(new Date(t.dueDate!)) === key(new Date())).map((t) => t._id),
    upcoming: open.filter((t) => startOfDay(new Date(t.dueDate!)) >= todayStart).map((t) => t._id),
  };
};

describe('date-only tasks (no due time): classification by due day', () => {
  const build = () => [
    makeTask({ _id: 'yesterday', dueDate: day('2026-10-19') }),
    makeTask({ _id: 'today', dueDate: day('2026-10-20') }),
    makeTask({ _id: 'tomorrow', dueDate: day('2026-10-21') }),
    makeTask({ _id: 'none' }),
    makeTask({ _id: 'done-today', dueDate: day('2026-10-20'), completed: true }),
  ];

  it.each(TIME_ZONES)('puts each task in the right section in %s', (tz) => {
    inTimeZone(tz, () => {
      at(2026, 10, 20, 12);
      expect(sections(build())).toEqual({
        overdue: ['yesterday'],
        today: ['today'],
        upcoming: ['today', 'tomorrow'], // upcoming includes today's, as it always has
      });
    });
  });

  it.each(['UTC', 'Asia/Kolkata', 'Pacific/Kiritimati'])('is exactly what it was before due times existed in %s (zones at or east of UTC)', (tz) => {
    inTimeZone(tz, () => {
      at(2026, 10, 20, 12);
      expect(sections(build())).toEqual(legacySections(build()));
    });
  });

  it('west of UTC the due day is the picked day: a task due today is no longer reported as overdue (a fix, only for UTC- zones)', () => {
    inTimeZone('America/Los_Angeles', () => {
      at(2026, 10, 20, 12);
      const tasks = build();
      expect(legacySections(tasks).overdue).toContain('today'); // the old behaviour, for the record
      expect(sections(tasks).overdue).toEqual(['yesterday']);
      expect(sections(tasks).today).toEqual(['today']);
    });
  });

  it.each(TIME_ZONES)('a day transition moves a task from today to overdue exactly at local midnight (%s)', (tz) => {
    inTimeZone(tz, () => {
      const tasks = [makeTask({ _id: 't', dueDate: day('2026-10-20') })];
      at(2026, 10, 20, 23, 59, 59);
      expect(sections(tasks)).toMatchObject({ overdue: [], today: ['t'] });
      at(2026, 10, 21, 0, 0, 0);
      expect(sections(tasks)).toMatchObject({ overdue: ['t'], today: [] });
    });
  });
});

describe('tasks with a due time: classification by the exact deadline', () => {
  it.each(TIME_ZONES)('is today before the time and overdue from it, the same day (%s)', (tz) => {
    inTimeZone(tz, () => {
      const tasks = [makeTask({ _id: 't', dueDate: day('2026-10-20'), dueTime: '09:00' })];
      at(2026, 10, 20, 8, 59, 59);
      expect(sections(tasks)).toEqual({ overdue: [], today: ['t'], upcoming: ['t'] });
      at(2026, 10, 20, 9, 0, 0);
      expect(sections(tasks)).toEqual({ overdue: ['t'], today: [], upcoming: [] });
    });
  });

  it('a due time on a later day does not make a task overdue or due today', () => {
    inTimeZone('Asia/Kolkata', () => {
      at(2026, 10, 20, 12);
      expect(sections([makeTask({ _id: 't', dueDate: day('2026-10-21'), dueTime: '00:00' })])).toEqual({ overdue: [], today: [], upcoming: ['t'] });
    });
  });

  it('adding a due time to one task never moves any other task between sections', () => {
    inTimeZone('Asia/Kolkata', () => {
      at(2026, 10, 20, 15);
      const others = () => [
        makeTask({ _id: 'a', dueDate: day('2026-10-19') }),
        makeTask({ _id: 'b', dueDate: day('2026-10-20') }),
        makeTask({ _id: 'c', dueDate: day('2026-10-22') }),
        makeTask({ _id: 'd', dueDate: day('2026-10-20'), dueTime: '23:00' }),
      ];
      const before = sections([...others(), makeTask({ _id: 'x', dueDate: day('2026-10-20') })]);
      const after = sections([...others(), makeTask({ _id: 'x', dueDate: day('2026-10-20'), dueTime: '08:00' })]);

      const without = (s: ReturnType<typeof sections>) => ({
        overdue: s.overdue.filter((id) => id !== 'x'),
        today: s.today.filter((id) => id !== 'x'),
        upcoming: s.upcoming.filter((id) => id !== 'x'),
      });
      expect(without(after)).toEqual(without(before));
      // ...and the edited task itself did move, as designed: its 08:00 deadline has passed at 15:00.
      expect(before.today).toContain('x');
      expect(after.overdue).toContain('x');
    });
  });

  it('ignores a due time that has no due date (it can only mean something next to one)', () => {
    at(2026, 10, 20, 12);
    expect(sections([makeTask({ _id: 't', dueTime: '09:00' })])).toEqual({ overdue: [], today: [], upcoming: [] });
  });
});

describe('upcoming order', () => {
  it('is by exact deadline, with a date-only task after the timed ones of its day, and honours the limit', () => {
    inTimeZone('Asia/Kolkata', () => {
      at(2026, 10, 20, 6);
      const tasks = [
        makeTask({ _id: 'date-only', dueDate: day('2026-10-20') }),
        makeTask({ _id: 'late', dueDate: day('2026-10-20'), dueTime: '21:00' }),
        makeTask({ _id: 'early', dueDate: day('2026-10-20'), dueTime: '07:00' }),
        makeTask({ _id: 'next-day', dueDate: day('2026-10-21'), dueTime: '00:30' }),
      ];
      expect(getUpcomingTasks(tasks, 10).map((t) => t._id)).toEqual(['early', 'late', 'date-only', 'next-day']);
      expect(getUpcomingTasks(tasks, 2).map((t) => t._id)).toEqual(['early', 'late']);
    });
  });
});
