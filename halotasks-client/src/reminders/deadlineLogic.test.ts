import { describe, expect, it } from 'vitest';
import { inTimeZone, makeTask } from '../test/taskFactory';
import {
  getDeadlineMs,
  getSmartStartWindows,
  getTasksDueInNextHour,
  getTasksOverdueNow,
  reminderSchedulePart,
} from './deadlineLogic';

const MIN = 60_000;
const utc = (iso: string) => Date.parse(iso);
const ids = (tasks: { _id: string }[]) => tasks.map((t) => t._id);

describe('tasks without a due time or start time: the established reminder behaviour is unchanged (regression)', () => {
  // A date-only task's deadline is its stored due date read as an instant, i.e. UTC midnight of the due day.
  // That is how it has always worked and it is deliberately preserved (and not extended to the new fields).
  const dateOnly = makeTask({ _id: 'date-only', dueDate: '2026-10-20T00:00:00.000Z' });

  it('uses the stored due date as an instant', () => {
    expect(getDeadlineMs(dateOnly)).toBe(utc('2026-10-20T00:00:00.000Z'));
    expect(getDeadlineMs(makeTask())).toBeNull();
    expect(getDeadlineMs(makeTask({ dueDate: 'garbage' }))).toBeNull();
  });

  it('is "due soon" in the hour before that instant and overdue from it', () => {
    expect(ids(getTasksDueInNextHour([dateOnly], utc('2026-10-19T23:00:01.000Z')))).toEqual(['date-only']);
    expect(ids(getTasksDueInNextHour([dateOnly], utc('2026-10-19T22:59:59.000Z')))).toEqual([]);
    expect(ids(getTasksOverdueNow([dateOnly], utc('2026-10-19T23:59:59.000Z')))).toEqual([]);
    expect(ids(getTasksOverdueNow([dateOnly], utc('2026-10-20T00:00:00.000Z')))).toEqual(['date-only']);
  });

  it('never reminds for a completed task or one with no due date', () => {
    const now = utc('2026-10-20T00:30:00.000Z');
    expect(getTasksOverdueNow([makeTask({ dueDate: '2026-10-20T00:00:00.000Z', completed: true }), makeTask()], now)).toEqual([]);
    expect(getTasksDueInNextHour([makeTask({ dueDate: '2026-10-20T01:00:00.000Z', completed: true }), makeTask()], now)).toEqual([]);
  });

  it('smart start still needs an estimate and a future deadline, and starts at deadline minus the estimate', () => {
    const due = '2026-10-20T12:00:00.000Z';
    const task = makeTask({ _id: 'est', dueDate: due, estimatedMinutes: 90 });
    const now = utc('2026-10-20T08:00:00.000Z');

    expect(getSmartStartWindows([task], now, 60)).toEqual([
      {
        task,
        dueTime: utc(due),
        latestStartTime: utc(due) - 90 * MIN,
        notifyAtTime: utc(due) - 90 * MIN - 60 * MIN,
        windowEndTime: utc(due),
      },
    ]);
    expect(getSmartStartWindows([makeTask({ dueDate: due, estimatedMinutes: 0 })], now)).toEqual([]);
    expect(getSmartStartWindows([makeTask({ dueDate: due })], now)).toEqual([]);
    expect(getSmartStartWindows([makeTask({ estimatedMinutes: 30 })], now)).toEqual([]);
    expect(getSmartStartWindows([makeTask({ dueDate: due, estimatedMinutes: 30 })], utc('2026-10-20T12:00:00.000Z'))).toEqual([]);
    expect(getSmartStartWindows([makeTask({ dueDate: due, estimatedMinutes: 30, completed: true })], now)).toEqual([]);
  });
});

describe('a due time: deadline reminders use the exact moment', () => {
  const timed = makeTask({ _id: 'timed', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' });

  it('is 17:30 in the viewer\'s zone', () => {
    inTimeZone('Asia/Kolkata', () => expect(getDeadlineMs(timed)).toBe(utc('2026-10-20T12:00:00.000Z')));
    inTimeZone('America/Los_Angeles', () => expect(getDeadlineMs(timed)).toBe(utc('2026-10-21T00:30:00.000Z')));
  });

  it('is due soon in the last hour and overdue from the exact moment (Kolkata: 12:00Z)', () => {
    inTimeZone('Asia/Kolkata', () => {
      expect(ids(getTasksDueInNextHour([timed], utc('2026-10-20T10:59:59.000Z')))).toEqual([]);
      expect(ids(getTasksDueInNextHour([timed], utc('2026-10-20T11:00:00.000Z')))).toEqual(['timed']);
      expect(ids(getTasksOverdueNow([timed], utc('2026-10-20T11:59:59.000Z')))).toEqual([]);
      expect(ids(getTasksOverdueNow([timed], utc('2026-10-20T12:00:00.000Z')))).toEqual(['timed']);
    });
  });

  it('is NOT treated as overdue at the UTC midnight that a date-only task would use', () => {
    inTimeZone('Asia/Kolkata', () => {
      const midnightUtc = utc('2026-10-20T00:00:00.000Z');
      expect(ids(getTasksOverdueNow([timed], midnightUtc))).toEqual([]);
      expect(ids(getTasksOverdueNow([makeTask({ _id: 'date-only', dueDate: '2026-10-20T00:00:00.000Z' })], midnightUtc))).toEqual(['date-only']);
    });
  });

  it('smart start counts back from the exact deadline', () => {
    inTimeZone('Asia/Kolkata', () => {
      const task = makeTask({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', estimatedMinutes: 60 });
      const [window] = getSmartStartWindows([task], utc('2026-10-20T06:00:00.000Z'), 30);
      expect(window.dueTime).toBe(utc('2026-10-20T12:00:00.000Z'));
      expect(window.latestStartTime).toBe(utc('2026-10-20T11:00:00.000Z'));
      expect(window.notifyAtTime).toBe(utc('2026-10-20T10:30:00.000Z'));
      expect(window.windowEndTime).toBe(utc('2026-10-20T12:00:00.000Z'));
    });
  });
});

describe('an explicit start time: used for start-based reminders, in place of the computed start', () => {
  const start = '2026-10-20T09:00:00.000Z';

  it('builds the window on the start time, and needs no estimate and no due date', () => {
    const task = makeTask({ startTime: start });
    const [window] = getSmartStartWindows([task], utc('2026-10-20T08:00:00.000Z'), 30);

    expect(window.latestStartTime).toBe(utc(start));
    expect(window.notifyAtTime).toBe(utc(start) - 30 * MIN);
    expect(window.dueTime).toBeNull();
    expect(window.windowEndTime).toBe(utc(start) + 30 * MIN); // a grace of one buffer, so it cannot re-fire forever
  });

  it('overrides the computed start when there is also an estimate and a deadline, and yields ONE window, never two', () => {
    const task = makeTask({ startTime: start, dueDate: '2026-10-20T00:00:00.000Z', dueTime: '23:00', estimatedMinutes: 120 });
    inTimeZone('UTC', () => {
      const windows = getSmartStartWindows([task], utc('2026-10-20T08:00:00.000Z'), 60);
      expect(windows).toHaveLength(1);
      expect(windows[0].latestStartTime).toBe(utc(start)); // not 23:00 - 120 min
      expect(windows[0].windowEndTime).toBe(utc('2026-10-20T23:00:00.000Z')); // ends at the exact deadline
    });
  });

  it('a date-only deadline does not end the window early (its legacy UTC-midnight instant has usually passed)', () => {
    const task = makeTask({ startTime: start, dueDate: '2026-10-20T00:00:00.000Z', estimatedMinutes: 60 });
    const windows = getSmartStartWindows([task], utc('2026-10-20T08:30:00.000Z'), 60);
    expect(windows).toHaveLength(1);
    expect(windows[0].windowEndTime).toBe(utc(start) + 60 * MIN);
  });

  it('drops a window that has already ended, a completed task, and a start time that cannot be read', () => {
    const now = utc('2026-10-20T12:00:00.000Z');
    expect(getSmartStartWindows([makeTask({ startTime: start })], now, 60)).toEqual([]);
    expect(getSmartStartWindows([makeTask({ startTime: start, completed: true })], utc('2026-10-20T08:00:00.000Z'))).toEqual([]);
    // An unreadable start falls back to the established rule (no estimate, so nothing).
    expect(getSmartStartWindows([makeTask({ startTime: 'soon' })], utc('2026-10-20T08:00:00.000Z'))).toEqual([]);
  });

  it('an unreadable start time falls back to the computed start when the task has an estimate and a deadline', () => {
    const due = '2026-10-20T12:00:00.000Z';
    const [window] = getSmartStartWindows([makeTask({ startTime: 'soon', dueDate: due, estimatedMinutes: 30 })], utc('2026-10-20T08:00:00.000Z'));
    expect(window.latestStartTime).toBe(utc(due) - 30 * MIN);
  });
});

describe('reminderSchedulePart (the de-duplication identity of a task\'s schedule)', () => {
  it('is exactly what it always was for a task with neither time, so nothing already sent is sent again', () => {
    expect(reminderSchedulePart(makeTask({ dueDate: '2026-10-20T00:00:00.000Z' }))).toBe('2026-10-20T00:00:00.000Z');
    expect(reminderSchedulePart(makeTask())).toBe('no-due-date');
  });

  it('includes a due time and a start time when present, so changing one re-arms the reminder', () => {
    const base = makeTask({ dueDate: '2026-10-20T00:00:00.000Z' });
    const withDue = reminderSchedulePart({ ...base, dueTime: '17:30' });
    const withStart = reminderSchedulePart({ ...base, startTime: '2026-10-20T09:00:00.000Z' });
    expect(new Set([reminderSchedulePart(base), withDue, withStart, reminderSchedulePart({ ...base, dueTime: '18:00' })]).size).toBe(4);
  });

  it('is unchanged by any other field (an unrelated edit, a retry or a sync must not re-send)', () => {
    const base = makeTask({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', startTime: '2026-10-20T09:00:00.000Z' });
    expect(
      reminderSchedulePart({ ...base, title: 'renamed', priority: 'high', tags: ['x'], estimatedMinutes: 5, pendingSync: true, updatedAt: 'later' }),
    ).toBe(reminderSchedulePart(base));
  });
});
