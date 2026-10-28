import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { createReminderScheduler } from './scheduler';
import { defaultReminderSettings } from './settings';

// The scheduler decides WHEN a reminder fires; these tests drive runNow() with a pinned clock and read what it sends.
// "Idempotent" here means: the same schedule never notifies twice in a session, whether the task was edited in an
// unrelated way, re-delivered by a sync, or the scheduler was recreated by a page reload.

const NOW = new Date(2026, 9, 20, 12, 0, 0); // local noon: outside the default quiet hours (22:30-07:00)
const at = (offsetMinutes: number) => vi.setSystemTime(new Date(NOW.getTime() + offsetMinutes * 60_000));
const iso = (offsetMinutes: number) => new Date(NOW.getTime() + offsetMinutes * 60_000).toISOString();

type Sent = { id: string; type: string };

const setup = (initial: Task[]) => {
  let tasks = initial;
  const sent: Sent[] = [];
  const scheduler = createReminderScheduler({
    getTasks: () => tasks,
    getSettings: () => ({ ...defaultReminderSettings, bufferMinutes: 30 }),
    onReminder: ({ task, type }) => sent.push({ id: task._id, type }),
  });
  return { scheduler, sent, setTasks: (next: Task[]) => (tasks = next) };
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

describe('explicit start time', () => {
  it('sends the heads-up before the start and "start now" at it, each once, with no estimate and no due date', () => {
    const task = makeTask({ _id: 'a', startTime: iso(45) });
    const { scheduler, sent } = setup([task]);

    scheduler.runNow(); // 45 min before the start: outside the 30-minute heads-up
    expect(sent).toEqual([]);

    at(20);
    scheduler.runNow(); // 25 min before: inside the heads-up
    scheduler.runNow(); // and again: nothing new
    expect(sent).toEqual([{ id: 'a', type: 'work-session-soon' }]);

    at(46);
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([
      { id: 'a', type: 'work-session-soon' },
      { id: 'a', type: 'start-now' },
    ]);
  });

  it('stops after the grace period instead of firing for an old start time in every new session', () => {
    const { scheduler, sent } = setup([makeTask({ _id: 'old', startTime: iso(-120) })]);

    scheduler.runNow();

    expect(sent).toEqual([]);
  });

  it('does not also fire the computed start reminders for the same task (one schedule, not two)', () => {
    // Without a start time this task (estimate 60, deadline in 70 min) would get its heads-up/start-now from the
    // computed start (deadline - 60 = in 10 min). With an explicit start in 3 hours, none of that applies.
    const task = makeTask({ _id: 'x', startTime: iso(180), estimatedMinutes: 60, dueDate: '2000-01-01T00:00:00.000Z' });
    const { scheduler, sent } = setup([task]);

    scheduler.runNow();
    at(15);
    scheduler.runNow();

    expect(sent.filter((s) => s.type === 'work-session-soon' || s.type === 'start-now')).toEqual([]);
  });
});

describe('idempotence: nothing is sent twice for the same schedule', () => {
  it('an edit of an unrelated field, a retry and a sync that re-deliver the task send nothing more', () => {
    const task = makeTask({ _id: 'a', startTime: iso(10) });
    const { scheduler, sent, setTasks } = setup([task]);
    scheduler.runNow();
    expect(sent).toHaveLength(1);

    setTasks([{ ...task, title: 'renamed', priority: 'high', tags: ['x'], estimatedMinutes: 25, pendingSync: true }]); // an edit
    scheduler.runNow();
    setTasks([{ ...task, title: 'renamed', pendingSync: false, updatedAt: 'later' }]); // the same task coming back from a sync
    scheduler.runNow();

    expect(sent).toEqual([{ id: 'a', type: 'work-session-soon' }]);
  });

  it('a recreated scheduler (page reload in the same session) does not repeat what the session already sent', () => {
    const task = makeTask({ _id: 'a', startTime: iso(10) });
    const first = setup([task]);
    first.scheduler.runNow();
    expect(first.sent).toHaveLength(1);

    const second = setup([task]); // reads the keys the first one saved in sessionStorage
    second.scheduler.runNow();

    expect(second.sent).toEqual([]);
  });

  it('changing the start time is a new schedule, so the reminder fires again for the new time', () => {
    const task = makeTask({ _id: 'a', startTime: iso(10) });
    const { scheduler, sent, setTasks } = setup([task]);
    scheduler.runNow();
    expect(sent).toHaveLength(1);

    setTasks([{ ...task, startTime: iso(20) }]);
    scheduler.runNow();

    expect(sent).toHaveLength(2);
  });

  it('changing the due time is a new schedule for its deadline reminders', () => {
    // Local 12:00 now. A due time 20 minutes ahead is "due soon"; moving it to 40 minutes ahead is a new schedule.
    const pad = (n: number) => String(n).padStart(2, '0');
    const hhmm = (offsetMinutes: number) => {
      const d = new Date(NOW.getTime() + offsetMinutes * 60_000);
      return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    const base = makeTask({ _id: 'd', dueDate: '2026-10-20T00:00:00.000Z', dueTime: hhmm(20) });
    const { scheduler, sent, setTasks } = setup([base]);

    scheduler.runNow();
    scheduler.runNow();
    expect(sent.filter((s) => s.type === 'due-soon')).toHaveLength(1);

    setTasks([{ ...base, dueTime: hhmm(40) }]);
    scheduler.runNow();
    expect(sent.filter((s) => s.type === 'due-soon')).toHaveLength(2);
  });

  it('a task with an exact deadline and no start time keeps the identity it always had (its key is type:id:dueDate)', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const later = new Date(NOW.getTime() + 20 * 60_000);
    const task = makeTask({ _id: 'legacy', dueDate: '2026-10-20T00:00:00.000Z', dueTime: `${pad(later.getHours())}:${pad(later.getMinutes())}` });
    const { scheduler } = setup([task]);

    scheduler.runNow();

    const keys = JSON.parse(sessionStorage.getItem('halotask_notified') ?? '[]') as string[];
    expect(keys.some((key) => key.startsWith('due-soon:legacy:2026-10-20T00:00:00.000Z'))).toBe(true);
  });
});

describe('legacy tasks and settings', () => {
  it('still gets the computed smart-start reminders from an estimate and an exact deadline', () => {
    const pad = (n: number) => String(n).padStart(2, '0');
    const deadline = new Date(NOW.getTime() + 100 * 60_000);
    const task = makeTask({
      _id: 'legacy',
      dueDate: '2026-10-20T00:00:00.000Z',
      dueTime: `${pad(deadline.getHours())}:${pad(deadline.getMinutes())}`,
      estimatedMinutes: 60,
    }); // latest start = in 40 min
    const { scheduler, sent } = setup([task]);

    at(15); // 25 min before the latest start: inside the 30-minute heads-up
    scheduler.runNow();

    expect(sent).toEqual([{ id: 'legacy', type: 'work-session-soon' }]);
  });

  it('sends nothing when reminders are disabled', () => {
    const sent: Sent[] = [];
    const scheduler = createReminderScheduler({
      getTasks: () => [makeTask({ startTime: iso(10) })],
      getSettings: () => ({ ...defaultReminderSettings, enabled: false }),
      onReminder: ({ task, type }) => sent.push({ id: task._id, type }),
    });

    scheduler.runNow();

    expect(sent).toEqual([]);
  });
});
