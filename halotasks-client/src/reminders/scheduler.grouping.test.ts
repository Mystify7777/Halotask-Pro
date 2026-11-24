import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { createReminderScheduler } from './scheduler';
import { defaultReminderSettings, type ReminderSettings } from './settings';

// Issue #14: one notification per task per poll, every merged reminder marked as fired, the 24 h overdue bound, and
// the date-only calendar-day reminders (Issue #42) left exactly as they were.

const NOW = new Date(2026, 9, 20, 12, 0, 0); // local noon: outside the default quiet hours
const at = (m: number) => vi.setSystemTime(new Date(NOW.getTime() + m * 60_000));
const iso = (m: number) => new Date(NOW.getTime() + m * 60_000).toISOString();
const dayOf = (m: number) => {
  const d = new Date(NOW.getTime() + m * 60_000);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
};
const hm = (m: number) => {
  const d = new Date(NOW.getTime() + m * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const due = (m: number) => ({ dueDate: dayOf(m), dueTime: hm(m) });

type Sent = { id: string; type: string; merged?: string[] };

const setup = (initial: Task[], settings: Partial<ReminderSettings> = {}) => {
  let tasks = initial;
  const sent: Sent[] = [];
  const make = () =>
    createReminderScheduler({
      getTasks: () => tasks,
      getSettings: () => ({ ...defaultReminderSettings, bufferMinutes: 30, ...settings }),
      onReminder: ({ task, type, merged }) => {
        sent.push({ id: task._id, type, merged });
      },
    });
  return { scheduler: make(), make, sent, setTasks: (next: Task[]) => (tasks = next) };
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers();
  at(0);
});
afterEach(() => {
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

describe('one notification per task per poll', () => {
  it('"due soon" and "start now" open together: one event, start-now leads', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'a', ...due(50), estimatedMinutes: 60 })]);
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'a', type: 'start-now', merged: ['start-now', 'due-soon'] }]);
  });

  it('an explicit start inside the last hour before the deadline: one event', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'b', ...due(40), startTime: iso(-10) })]);
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'b', type: 'start-now', merged: ['start-now', 'due-soon'] }]);
  });

  it('the heads-up and "due soon" together: due-soon leads', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'c', ...due(45), estimatedMinutes: 30 })]);
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'c', type: 'due-soon', merged: ['due-soon', 'work-session-soon'] }]);
  });

  it('a lone reminder is an event with a merge of one', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'd', ...due(30) })]);
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon', merged: ['due-soon'] }]);
  });

  it('different tasks are never merged, even when they fire in the same poll', () => {
    const { scheduler, sent } = setup([
      makeTask({ _id: 'a', ...due(30) }),
      makeTask({ _id: 'b', ...due(30) }),
      makeTask({ _id: 'c', ...due(-5) }),
    ]);
    scheduler.runNow();
    expect(sent.map((s) => [s.id, s.merged])).toEqual([
      ['a', ['due-soon']],
      ['b', ['due-soon']],
      ['c', ['overdue']],
    ]);
  });

  it('the result does not depend on the order the tasks arrive in', () => {
    const tasks = [makeTask({ _id: 'a', ...due(50), estimatedMinutes: 60 }), makeTask({ _id: 'b', ...due(45), estimatedMinutes: 30 })];
    const forward = setup(tasks);
    forward.scheduler.runNow();
    sessionStorage.clear();
    localStorage.clear(); // two independent browsers: the shared claims (Issue #69) of the first must not hide the second
    const backward = setup([...tasks].reverse());
    backward.scheduler.runNow();
    const byId = (list: Sent[]) => Object.fromEntries(list.map((s) => [s.id, s]));
    expect(byId(backward.sent)).toEqual(byId(forward.sent));
  });
});

describe('every merged reminder counts as fired', () => {
  it('a merged heads-up does not fire again on its own later, and polling again sends nothing', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'c', ...due(45), estimatedMinutes: 30 })]);
    scheduler.runNow();
    scheduler.runNow();
    at(14); // still inside the heads-up window, 31 min before the deadline
    scheduler.runNow();
    expect(sent).toHaveLength(1);
  });

  it('a later reminder is its own notification when the earlier one already went out', () => {
    // Heads-up first (alone: due-soon opens later), then due-soon + start-now, each only with what is new.
    const { scheduler, sent } = setup([makeTask({ _id: 'e', ...due(95), estimatedMinutes: 60 })]);
    at(10); // deadline in 85: heads-up window (latest start = in 35, buffer 30 -> from in 5)
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'e', type: 'work-session-soon', merged: ['work-session-soon'] }]);
    at(40); // deadline in 55: due-soon opens, start-now opens (latest start passed)
    scheduler.runNow();
    expect(sent[1]).toEqual({ id: 'e', type: 'start-now', merged: ['start-now', 'due-soon'] });
    expect(sent).toHaveLength(2);
  });

  it('a recreated scheduler in the same session repeats nothing', () => {
    const first = setup([makeTask({ _id: 'a', ...due(50), estimatedMinutes: 60 })]);
    first.scheduler.runNow();
    first.make().runNow();
    expect(first.sent).toHaveLength(1);
  });

  it('a disabled type is not part of the merge', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'a', ...due(50), estimatedMinutes: 60 })], { dueSoonEnabled: false });
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'a', type: 'start-now', merged: ['start-now'] }]);
  });

  it('quiet hours and the master switch still stop everything', () => {
    const tasks = [makeTask({ _id: 'a', ...due(50), estimatedMinutes: 60 })];
    const quiet = setup(tasks, { quietHoursStart: '11:00', quietHoursEnd: '13:00' });
    quiet.scheduler.runNow();
    const off = setup(tasks, { enabled: false });
    off.scheduler.runNow();
    expect([...quiet.sent, ...off.sent]).toEqual([]);
  });
});

describe('timed overdue notifications stop 24 hours after the deadline', () => {
  const HOUR = 60;
  it('notifies up to and including 24 h after the deadline, and not after', () => {
    const exactly = setup([makeTask({ _id: 'x', ...due(-24 * HOUR) })]);
    exactly.scheduler.runNow();
    expect(exactly.sent).toEqual([{ id: 'x', type: 'overdue', merged: ['overdue'] }]);

    sessionStorage.clear();
    const stale = setup([makeTask({ _id: 'y', ...due(-24 * HOUR - 1) })]);
    stale.scheduler.runNow();
    expect(stale.sent).toEqual([]);
  });

  it('reopening the app (a new session) does not announce tasks that went overdue days ago', () => {
    const { scheduler, sent } = setup([1, 2, 3].map((n) => makeTask({ _id: `o${n}`, ...due(-24 * HOUR * n) })));
    scheduler.runNow();
    expect(sent.map((s) => s.id)).toEqual(['o1']); // only the one inside the window
  });

  it('the task itself is still overdue: only the notification is bounded', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'old', ...due(-72 * HOUR) })]);
    scheduler.runNow();
    expect(sent).toEqual([]);
  });
});

describe('date-only calendar-day reminders are untouched', () => {
  it('still one event per reminder, with no merge, and no 24 h-window change', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'd', dueDate: dayOf(0) })]);
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon', merged: undefined }]);
  });
});
