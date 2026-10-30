import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inTimeZone, makeTask, TIME_ZONES } from '../test/taskFactory';
import type { Task } from '../types/task';
import { getExactDeadline } from '../utils/deadline';
import { setPreferredTimeZone, zonedWallClockToInstant } from '../utils/timeZone';
import {
  getDateOnlyReminderPhase,
  getDateOnlyTasksInPhase,
  getDeadlineMs,
  getSmartStartWindows,
  getTasksOverdueNow,
} from './deadlineLogic';
import { getReminderPayload } from './notification';
import { createReminderScheduler, resetDayReminderFallback } from './scheduler';
import { defaultReminderSettings, type ReminderSettings } from './settings';

// Issue #42 — a date-only task is a calendar day, not an instant. It is reminded "due today" on its due day and
// "overdue" on the day after, both judged in the effective zone, and it never acquires an exact deadline.
//
// Every test pins the zone through the saved preference (and, where it matters, a different machine zone), so none
// depends on the machine it runs on.

const utc = (iso: string) => Date.parse(iso);
const DAY = '2026-10-20';
const STORED = `${DAY}T00:00:00.000Z`; // how the server stores a due day
const dateOnly = (overrides: Partial<Task> = {}) => makeTask({ _id: 'd', dueDate: STORED, ...overrides });

/** The first instant of calendar day `y-m-d` in `zone` (every zone used here has a midnight on the days tested). */
const startOfDay = (y: number, m: number, d: number, zone: string) => zonedWallClockToInstant(y, m, d, 0, 0, zone);

afterEach(() => setPreferredTimeZone(null));

describe('calendar-day boundaries (the phase of a date-only task)', () => {
  it('is not due before its day, due all day, overdue on the next day, and silent after that — in Asia/Kolkata', () => {
    setPreferredTimeZone('Asia/Kolkata'); // 2026-10-20 00:00 IST = 2026-10-19T18:30Z
    const task = dateOnly();
    const phase = (iso: string) => getDateOnlyReminderPhase(task, utc(iso));

    expect(phase('2026-10-19T18:29:59.999Z')).toBeNull(); // 23:59:59.999 on the 19th
    expect(phase('2026-10-19T18:30:00.000Z')).toBe('due-today');
    expect(phase('2026-10-20T18:29:59.999Z')).toBe('due-today'); // 23:59:59.999 on the 20th
    expect(phase('2026-10-20T18:30:00.000Z')).toBe('overdue'); // midnight: the day has ended
    expect(phase('2026-10-21T18:29:59.999Z')).toBe('overdue');
    expect(phase('2026-10-21T18:30:00.000Z')).toBeNull(); // a day later: never replayed
  });

  it('UTC midnight does not trigger the reminder the legacy way: it is just 05:30 on the due day in Kolkata, 17:00 the day before in Los Angeles', () => {
    const task = dateOnly();
    const midnightUtc = utc(`${DAY}T00:00:00.000Z`);

    setPreferredTimeZone('Asia/Kolkata');
    expect(getDateOnlyReminderPhase(task, midnightUtc)).toBe('due-today'); // legacy: "overdue" from this instant
    expect(getTasksOverdueNow([task], midnightUtc)).toEqual([]);

    setPreferredTimeZone('America/Los_Angeles');
    expect(getDateOnlyReminderPhase(task, midnightUtc)).toBeNull(); // legacy: "overdue" from this instant
    expect(getTasksOverdueNow([task], midnightUtc)).toEqual([]);
  });

  it.each(TIME_ZONES)('%s: the same stored day starts at the zone\'s own midnight and ends at the next one', (zone) => {
    const task = dateOnly();
    const [y, m] = [2026, 10];
    const first = startOfDay(y, m, 20, zone);
    const next = startOfDay(y, m, 21, zone);
    const afterThat = startOfDay(y, m, 22, zone);

    // The result must not depend on the machine's own zone.
    for (const machine of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      inTimeZone(machine, () => {
        setPreferredTimeZone(zone);
        expect(getDateOnlyReminderPhase(task, first - 1)).toBeNull();
        expect(getDateOnlyReminderPhase(task, first)).toBe('due-today');
        expect(getDateOnlyReminderPhase(task, next - 1)).toBe('due-today');
        expect(getDateOnlyReminderPhase(task, next)).toBe('overdue');
        expect(getDateOnlyReminderPhase(task, afterThat - 1)).toBe('overdue');
        expect(getDateOnlyReminderPhase(task, afterThat)).toBeNull();
      });
    }
  });

  it('positive and negative extremes read the same day at very different instants (Kiritimati +14:00, Pago Pago -11:00)', () => {
    const task = dateOnly();
    setPreferredTimeZone('Pacific/Kiritimati');
    expect(getDateOnlyReminderPhase(task, utc('2026-10-19T10:00:00.000Z'))).toBe('due-today'); // 00:00 on the 20th there
    setPreferredTimeZone('Pacific/Pago_Pago');
    expect(getDateOnlyReminderPhase(task, utc('2026-10-19T10:00:00.000Z'))).toBeNull(); // still the 18th there
    expect(getDateOnlyReminderPhase(task, utc('2026-10-20T11:00:00.000Z'))).toBe('due-today'); // 00:00 on the 20th there
  });

  it('only a date-only, unfinished task with a usable due date has a phase', () => {
    setPreferredTimeZone('UTC');
    const now = utc(`${DAY}T12:00:00.000Z`);
    expect(getDateOnlyReminderPhase(makeTask(), now)).toBeNull(); // no due date
    expect(getDateOnlyReminderPhase(makeTask({ dueDate: 'garbage' }), now)).toBeNull();
    expect(getDateOnlyReminderPhase(dateOnly({ completed: true }), now)).toBeNull();
    expect(getDateOnlyReminderPhase(dateOnly({ dueTime: '17:30' }), now)).toBeNull(); // an exact deadline: not date-only
    expect(getDateOnlyReminderPhase(dateOnly(), now)).toBe('due-today');
  });

  it('every stored shape of a due day keeps working (existing date-only tasks stay valid)', () => {
    setPreferredTimeZone('UTC');
    const now = utc(`${DAY}T12:00:00.000Z`);
    for (const dueDate of [DAY, STORED, `${DAY}T00:00:00Z`]) {
      expect(getDateOnlyReminderPhase(makeTask({ dueDate }), now)).toBe('due-today');
    }
  });

  it('getDateOnlyTasksInPhase keeps only the tasks in that phase', () => {
    setPreferredTimeZone('UTC');
    const now = utc('2026-10-21T08:00:00.000Z');
    const today = makeTask({ _id: 'today', dueDate: '2026-10-21T00:00:00.000Z' });
    const yesterday = makeTask({ _id: 'yesterday', dueDate: STORED });
    const old = makeTask({ _id: 'old', dueDate: '2026-10-01T00:00:00.000Z' });
    const timed = makeTask({ _id: 'timed', dueDate: '2026-10-21T00:00:00.000Z', dueTime: '09:00' });
    const tasks = [today, yesterday, old, timed, makeTask({ _id: 'none' })];

    expect(getDateOnlyTasksInPhase(tasks, 'due-today', now).map((t) => t._id)).toEqual(['today']);
    expect(getDateOnlyTasksInPhase(tasks, 'overdue', now).map((t) => t._id)).toEqual(['yesterday']);
  });
});

describe('time zone preference', () => {
  // 2026-10-20T20:00Z is 01:30 on the 21st in Kolkata and 13:00 on the 20th in Los Angeles.
  const now = utc('2026-10-20T20:00:00.000Z');

  it('a saved zone takes precedence over the machine zone', () => {
    const task = dateOnly();
    inTimeZone('America/Los_Angeles', () => {
      setPreferredTimeZone('Asia/Kolkata');
      expect(getDateOnlyReminderPhase(task, now)).toBe('overdue');
    });
    inTimeZone('Asia/Kolkata', () => {
      setPreferredTimeZone('America/Los_Angeles');
      expect(getDateOnlyReminderPhase(task, now)).toBe('due-today');
    });
  });

  it('with no saved zone the device zone decides (the existing fallback), and nothing is written back', () => {
    const task = dateOnly();
    setPreferredTimeZone(null);
    inTimeZone('Asia/Kolkata', () => expect(getDateOnlyReminderPhase(task, now)).toBe('overdue'));
    inTimeZone('America/Los_Angeles', () => expect(getDateOnlyReminderPhase(task, now)).toBe('due-today'));
  });

  it('changing the zone re-reads the phase without touching the task', () => {
    const task = Object.freeze(dateOnly()); // a write to a frozen object throws in strict mode
    const before = JSON.stringify(task);

    setPreferredTimeZone('America/Los_Angeles');
    expect(getDateOnlyReminderPhase(task, now)).toBe('due-today');
    setPreferredTimeZone('Asia/Kolkata');
    expect(getDateOnlyReminderPhase(task, now)).toBe('overdue');
    setPreferredTimeZone(null);

    expect(JSON.stringify(task)).toBe(before);
    expect(task.dueDate).toBe(STORED);
  });
});

describe('daylight saving and offset changes at the day boundary', () => {
  it('America/Los_Angeles, spring forward (a 23-hour day): the day still ends at the next local midnight', () => {
    setPreferredTimeZone('America/Los_Angeles');
    const task = makeTask({ dueDate: '2026-03-08T00:00:00.000Z' });
    const start = startOfDay(2026, 3, 8, 'America/Los_Angeles'); // 08:00Z, PST
    const end = startOfDay(2026, 3, 9, 'America/Los_Angeles'); // 07:00Z, PDT

    expect(end - start).toBe(23 * 3_600_000);
    expect(getDateOnlyReminderPhase(task, start - 1)).toBeNull();
    expect(getDateOnlyReminderPhase(task, start)).toBe('due-today');
    expect(getDateOnlyReminderPhase(task, end - 1)).toBe('due-today');
    expect(getDateOnlyReminderPhase(task, end)).toBe('overdue');
  });

  it('America/Los_Angeles, fall back (a 25-hour day): the repeated hour does not end the day early or late', () => {
    setPreferredTimeZone('America/Los_Angeles');
    const task = makeTask({ dueDate: '2026-11-01T00:00:00.000Z' });
    const start = startOfDay(2026, 11, 1, 'America/Los_Angeles'); // 07:00Z, PDT
    const end = startOfDay(2026, 11, 2, 'America/Los_Angeles'); // 08:00Z, PST

    expect(end - start).toBe(25 * 3_600_000);
    expect(getDateOnlyReminderPhase(task, start + 24 * 3_600_000)).toBe('due-today'); // 24h in: still the 1st
    expect(getDateOnlyReminderPhase(task, end - 1)).toBe('due-today');
    expect(getDateOnlyReminderPhase(task, end)).toBe('overdue');
  });

  it('Australia/Lord_Howe (a 30-minute shift): the boundary is still local midnight', () => {
    setPreferredTimeZone('Australia/Lord_Howe');
    const task = makeTask({ dueDate: '2026-10-04T00:00:00.000Z' }); // spring forward on 2026-10-04 at 02:00
    const end = startOfDay(2026, 10, 5, 'Australia/Lord_Howe');

    expect(getDateOnlyReminderPhase(task, end - 1)).toBe('due-today');
    expect(getDateOnlyReminderPhase(task, end)).toBe('overdue');
  });

  it('America/Havana, whose clocks skip midnight itself: the day still starts and ends on a real local reading', () => {
    // Cuba springs forward at 00:00 -> 01:00 on 2026-03-08, so that day has no 00:00. The phase reads the calendar
    // day of the instant, so it does not need midnight to exist.
    setPreferredTimeZone('America/Havana');
    const task = makeTask({ dueDate: '2026-03-08T00:00:00.000Z' });
    const springForward = utc('2026-03-08T05:00:00.000Z'); // 00:00 CST would be 05:00Z; the clock jumps to 01:00 CDT

    expect(getDateOnlyReminderPhase(task, springForward - 1)).toBeNull(); // 23:59:59.999 on the 7th
    expect(getDateOnlyReminderPhase(task, springForward)).toBe('due-today'); // 01:00 on the 8th
  });
});

describe('date-only and exact-time tasks stay separate', () => {
  it('a date-only task never acquires an exact deadline, in any zone, and is left unchanged', () => {
    const task = Object.freeze(dateOnly());
    for (const zone of TIME_ZONES) {
      setPreferredTimeZone(zone);
      expect(getExactDeadline(task)).toBeNull();
      expect(getDeadlineMs(task)).toBeNull();
      getDateOnlyReminderPhase(task, utc(`${DAY}T12:00:00.000Z`));
    }
    expect(task.dueTime).toBeUndefined();
    expect(task.dueDate).toBe(STORED);
  });

  it('a date-only task gets no computed start window, but an explicit start time still works for it', () => {
    setPreferredTimeZone('UTC');
    const now = utc(`${DAY}T08:00:00.000Z`);
    expect(getSmartStartWindows([dateOnly({ estimatedMinutes: 60 })], now)).toEqual([]);

    const start = `${DAY}T09:00:00.000Z`;
    const [window] = getSmartStartWindows([dateOnly({ startTime: start })], now, 30);
    expect(window.latestStartTime).toBe(utc(start));
    expect(window.windowEndTime).toBe(utc(start) + 30 * 60_000);
    expect(window.dueTime).toBeNull();
  });

  it('a timed task keeps its exact deadline, its overdue-forever behaviour and its wording', () => {
    setPreferredTimeZone('Asia/Kolkata');
    const timed = makeTask({ _id: 'timed', title: 'Pay rent', dueDate: STORED, dueTime: '17:30' });

    expect(getDeadlineMs(timed)).toBe(utc(`${DAY}T12:00:00.000Z`));
    expect(getTasksOverdueNow([timed], utc('2026-10-25T00:00:00.000Z')).map((t) => t._id)).toEqual(['timed']); // days later
    expect(getDateOnlyReminderPhase(timed, utc(`${DAY}T12:00:00.000Z`))).toBeNull();
    expect(getReminderPayload(timed, 'due-soon').body).toBe('Pay rent is due within the next hour.');
    expect(getReminderPayload(timed, 'overdue').body).toBe('Pay rent is now overdue.');
  });

  it('a date-only task is told "due today"; its overdue wording is unchanged', () => {
    const task = dateOnly({ title: 'Pay rent' });
    expect(getReminderPayload(task, 'due-soon').body).toBe('Pay rent is due today.');
    expect(getReminderPayload(task, 'overdue').body).toBe('Pay rent is now overdue.');
    expect(getReminderPayload(task, 'overdue').tag).toContain(STORED);
  });

  it('a task with no due date is unaffected by any of this', () => {
    setPreferredTimeZone('UTC');
    const task = makeTask({ _id: 'none', startTime: `${DAY}T09:00:00.000Z` });
    expect(getDateOnlyReminderPhase(task, utc(`${DAY}T12:00:00.000Z`))).toBeNull();
    expect(getDeadlineMs(task)).toBeNull();
  });
});

describe('scheduler: delivery, de-duplication, restarts and offline', () => {
  const sessionKey = 'halotask_notified';
  const noQuietHours: ReminderSettings = { ...defaultReminderSettings, quietHoursStart: '00:00', quietHoursEnd: '00:00' };

  type Sent = { id: string; type: string };

  const setup = (initial: Task[], settings: ReminderSettings = noQuietHours) => {
    let tasks = initial;
    const sent: Sent[] = [];
    const scheduler = createReminderScheduler({
      getTasks: () => tasks,
      getSettings: () => settings,
      onReminder: ({ task, type }) => sent.push({ id: task._id, type }),
    });
    return { scheduler, sent, setTasks: (next: Task[]) => (tasks = next) };
  };

  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    localStorage.clear();
  });

  it('sends "due today" once on the due day and "overdue" once on the next, however often it polls', () => {
    setPreferredTimeZone('Asia/Kolkata');
    const { scheduler, sent } = setup([dateOnly()]);

    at('2026-10-19T18:00:00.000Z'); // 23:30 on the 19th: not yet
    scheduler.runNow();
    expect(sent).toEqual([]);

    at('2026-10-19T18:31:00.000Z'); // 00:01 on the 20th
    scheduler.runNow();
    at('2026-10-20T06:00:00.000Z');
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);

    at('2026-10-20T18:31:00.000Z'); // 00:01 on the 21st
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([
      { id: 'd', type: 'due-soon' },
      { id: 'd', type: 'overdue' },
    ]);
  });

  it('UTC midnight does not fire anything while the effective zone has not reached the day', () => {
    setPreferredTimeZone('America/Los_Angeles');
    const { scheduler, sent } = setup([dateOnly()]);

    at(`${DAY}T00:00:00.000Z`); // 17:00 on the 19th in Los Angeles
    scheduler.runNow();
    at(`${DAY}T06:59:00.000Z`); // 23:59 on the 19th
    scheduler.runNow();

    expect(sent).toEqual([]);

    at(`${DAY}T07:00:00.000Z`); // 00:00 on the 20th
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('changing the preferred zone re-evaluates pending date-only reminders and never sends a day twice', () => {
    const task = Object.freeze(dateOnly());
    const { scheduler, sent } = setup([task]);

    setPreferredTimeZone('America/Los_Angeles');
    at(`${DAY}T06:00:00.000Z`); // 23:00 on the 19th in Los Angeles
    scheduler.runNow();
    expect(sent).toEqual([]);

    setPreferredTimeZone('Asia/Kolkata'); // 11:30 on the 20th: the day is here
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);

    setPreferredTimeZone('America/Los_Angeles'); // and back: the 19th again, nothing new
    scheduler.runNow();
    setPreferredTimeZone('Asia/Kolkata');
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);

    setPreferredTimeZone('America/Los_Angeles');
    at('2026-10-21T08:00:00.000Z'); // 01:00 on the 21st in Los Angeles: the day has ended there
    scheduler.runNow();
    setPreferredTimeZone('Asia/Kolkata'); // 13:30 on the 21st: also the day after
    scheduler.runNow();
    expect(sent).toEqual([
      { id: 'd', type: 'due-soon' },
      { id: 'd', type: 'overdue' },
    ]);
    expect(task.dueDate).toBe(STORED);
  });

  it('after "overdue" has gone out, moving the zone back into the due day does not send "due today" afterwards', () => {
    const { scheduler, sent } = setup([dateOnly()]);

    setPreferredTimeZone('Asia/Kolkata');
    at('2026-10-20T19:00:00.000Z'); // 00:30 on the 21st in Kolkata
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'overdue' }]);

    setPreferredTimeZone('America/Los_Angeles'); // 12:00 on the 20th: due today there
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'overdue' }]);
  });

  it('an unrelated edit, a start time, a sync and an offline-to-server id change send nothing more', () => {
    setPreferredTimeZone('UTC');
    const local = dateOnly({ _id: 'local-1', clientKey: 'local-1', pendingSync: true });
    const { scheduler, sent, setTasks } = setup([local]);

    at(`${DAY}T09:00:00.000Z`);
    scheduler.runNow();
    expect(sent).toHaveLength(1);

    setTasks([{ ...local, title: 'renamed', priority: 'high', startTime: `${DAY}T20:00:00.000Z`, updatedAt: 'later' }]);
    scheduler.runNow();
    setTasks([{ ...local, _id: '507f1f77bcf86cd799439011', clientKey: 'local-1', pendingSync: false }]); // synced: new _id
    scheduler.runNow();

    expect(sent).toHaveLength(1);
  });

  it('a restart in the same day (a new scheduler, a new browser session) does not repeat the reminder', () => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
    const first = setup([dateOnly()]);
    first.scheduler.runNow();
    expect(first.sent).toHaveLength(1);

    sessionStorage.clear(); // a new session: only what is persisted survives
    const second = setup([dateOnly()]);
    second.scheduler.runNow();
    at(`${DAY}T15:00:00.000Z`);
    second.scheduler.runNow();
    expect(second.sent).toEqual([]);
  });

  it('a restart on the next day sends the "overdue" it has not sent yet, once', () => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
    setup([dateOnly()]).scheduler.runNow();

    sessionStorage.clear();
    at('2026-10-21T09:00:00.000Z');
    const second = setup([dateOnly()]);
    second.scheduler.runNow();
    second.scheduler.runNow();
    expect(second.sent).toEqual([{ id: 'd', type: 'overdue' }]);
  });

  it('does not replay stale reminders after being offline or closed for the whole window', () => {
    setPreferredTimeZone('UTC');
    at('2026-10-22T08:00:00.000Z'); // two days after the due day: both windows are gone
    const { scheduler, sent } = setup([dateOnly(), dateOnly({ _id: 'old', dueDate: '2026-09-01T00:00:00.000Z' })]);

    scheduler.runNow();
    scheduler.runNow();

    expect(sent).toEqual([]);
  });

  it('after the app was closed through the due day, reconnecting the day after sends one "overdue", not a "due today" too', () => {
    setPreferredTimeZone('UTC');
    at('2026-10-21T10:00:00.000Z');
    const { scheduler, sent } = setup([dateOnly()]);

    scheduler.runNow();

    expect(sent).toEqual([{ id: 'd', type: 'overdue' }]);
  });

  it('respects quiet hours (the device clock, as before) and sends once they end', () => {
    setPreferredTimeZone(null); // the device zone, which is also what quiet hours use
    const { scheduler, sent } = setup([dateOnly()], defaultReminderSettings); // quiet 22:30-07:00

    vi.setSystemTime(new Date(2026, 9, 20, 6, 0)); // 06:00 local on the due day
    scheduler.runNow();
    expect(sent).toEqual([]);

    vi.setSystemTime(new Date(2026, 9, 20, 7, 1));
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('honours the existing toggles: "due soon" gates "due today", "overdue" gates "overdue"', () => {
    setPreferredTimeZone('UTC');

    at(`${DAY}T09:00:00.000Z`);
    const noDue = setup([dateOnly()], { ...noQuietHours, dueSoonEnabled: false });
    noDue.scheduler.runNow();
    expect(noDue.sent).toEqual([]);

    at('2026-10-21T09:00:00.000Z');
    const noOverdue = setup([dateOnly({ _id: 'e' })], { ...noQuietHours, overdueEnabled: false });
    noOverdue.scheduler.runNow();
    expect(noOverdue.sent).toEqual([]);

    const off = setup([dateOnly({ _id: 'f' })], { ...noQuietHours, enabled: false });
    off.scheduler.runNow();
    expect(off.sent).toEqual([]);
  });

  it('never reminds for a completed date-only task or one with no due date', () => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
    const { scheduler, sent } = setup([dateOnly({ completed: true }), makeTask()]);
    scheduler.runNow();
    expect(sent).toEqual([]);
  });

  it('an exact-time task still reminds from its exact instant (due soon, then overdue), unaffected by the day logic', () => {
    setPreferredTimeZone('UTC');
    const timed = makeTask({ _id: 'timed', dueDate: STORED, dueTime: '17:30' });
    const { scheduler, sent } = setup([timed]);

    at(`${DAY}T00:00:00.000Z`); // UTC midnight: nothing for a timed task
    scheduler.runNow();
    expect(sent).toEqual([]);

    at(`${DAY}T16:45:00.000Z`);
    scheduler.runNow();
    at(`${DAY}T17:31:00.000Z`);
    scheduler.runNow();
    expect(sent).toEqual([
      { id: 'timed', type: 'due-soon' },
      { id: 'timed', type: 'overdue' },
    ]);
  });

  it('prunes receipts of old due days and survives unreadable stored receipts', () => {
    setPreferredTimeZone('UTC');
    localStorage.setItem('halotask_day_reminders', JSON.stringify({ 'day:overdue:gone:2026-09-01': '2026-09-01' }));
    at(`${DAY}T09:00:00.000Z`);
    setup([dateOnly()]).scheduler.runNow();

    const kept = JSON.parse(localStorage.getItem('halotask_day_reminders') ?? '{}') as Record<string, string>;
    expect(Object.keys(kept)).toEqual([`day:due-soon:d:${DAY}`]);

    localStorage.setItem('halotask_day_reminders', '{not json');
    const { scheduler, sent } = setup([dateOnly({ _id: 'other' })]);
    expect(() => scheduler.runNow()).not.toThrow();
    expect(sent).toEqual([{ id: 'other', type: 'due-soon' }]);
    expect(sessionStorage.getItem(sessionKey)).toBeNull(); // date-only day reminders do not use the session key
  });
});

// ── Review follow-up ─────────────────────────────────────────────────────────────────────────────────────────────
// Shared harness for the three groups below. Each "tab" is its own scheduler over the same localStorage, which is
// exactly what two tabs of one browser are.

const RECEIPTS_KEY = 'halotask_day_reminders';
const NO_QUIET_HOURS: ReminderSettings = { ...defaultReminderSettings, quietHoursStart: '00:00', quietHoursEnd: '00:00' };
const at = (iso: string) => vi.setSystemTime(new Date(iso));
const receiptKeys = () => Object.keys(JSON.parse(localStorage.getItem(RECEIPTS_KEY) ?? '{}') as Record<string, unknown>);
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

type Reminder = { id: string; type: string };

const makeTab = (tasks: Task[], deliver?: (event: { task: Task; type: string }) => unknown) => {
  const sent: Reminder[] = [];
  const scheduler = createReminderScheduler({
    getTasks: () => tasks,
    getSettings: () => NO_QUIET_HOURS,
    onReminder: (event) => {
      const result = deliver ? deliver(event) : undefined;
      if (result !== false) sent.push({ id: event.task._id, type: event.type });
      return result;
    },
  });
  return { scheduler, sent };
};

const withFakeClock = () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    sessionStorage.clear();
    localStorage.clear();
  });
};

describe('a time zone change never produces both reminders for one due day (review finding 1)', () => {
  withFakeClock();

  it('due today, then the zone moves so the day has already ended: no "overdue"', () => {
    const { scheduler, sent } = makeTab([dateOnly()]);

    setPreferredTimeZone('America/Los_Angeles');
    at('2026-10-20T19:00:00.000Z'); // 12:00 on the 20th in Los Angeles
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);

    setPreferredTimeZone('Asia/Kolkata'); // 00:30 on the 21st: overdue there, and the user was told 30 seconds ago
    scheduler.runNow();
    scheduler.runNow();
    at('2026-10-20T20:00:00.000Z');
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);

    at('2026-10-21T19:00:00.000Z'); // the 22nd in Kolkata: past the window altogether
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('overdue, then the zone moves back into the due day: no "due today"', () => {
    const { scheduler, sent } = makeTab([dateOnly()]);

    setPreferredTimeZone('Asia/Kolkata');
    at('2026-10-20T19:00:00.000Z'); // 00:30 on the 21st in Kolkata
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'overdue' }]);

    setPreferredTimeZone('America/Los_Angeles'); // 12:00 on the 20th: due today there
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'overdue' }]);
  });

  it('both directions, one task: flipping the zone back and forth sends exactly one reminder', () => {
    const { scheduler, sent } = makeTab([dateOnly()]);
    at('2026-10-20T19:00:00.000Z'); // the 20th in Los Angeles, the 21st in Kolkata

    for (const zone of ['America/Los_Angeles', 'Asia/Kolkata', 'America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Pago_Pago']) {
      setPreferredTimeZone(zone);
      scheduler.runNow();
    }

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({ id: 'd', type: 'due-soon' });
  });

  it('when the day simply passes, "due today" and then "overdue" the next day are both sent (the normal sequence)', () => {
    const { scheduler, sent } = makeTab([dateOnly()]);
    setPreferredTimeZone('Asia/Kolkata');

    at('2026-10-20T03:00:00.000Z'); // 08:30 on the 20th
    scheduler.runNow();
    at('2026-10-21T03:00:00.000Z'); // 08:30 on the 21st
    scheduler.runNow();

    expect(sent).toEqual([
      { id: 'd', type: 'due-soon' },
      { id: 'd', type: 'overdue' },
    ]);
  });

  it('a zone change that does not make the day end early still lets the next day\'s "overdue" through', () => {
    const { scheduler, sent } = makeTab([dateOnly()]);

    setPreferredTimeZone('Asia/Kolkata');
    at('2026-10-20T03:00:00.000Z'); // 08:30 on the 20th in Kolkata, still the 19th in Los Angeles
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);

    setPreferredTimeZone('America/Los_Angeles');
    at('2026-10-21T07:30:00.000Z'); // 00:30 on the 21st in Los Angeles: the day has genuinely ended there
    scheduler.runNow();

    expect(sent).toEqual([
      { id: 'd', type: 'due-soon' },
      { id: 'd', type: 'overdue' },
    ]);
  });

  it('a receipt in the earlier stored shape (the bare due day, no time) still reads, and cannot block "overdue"', () => {
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify({ [`day:due-soon:d:${DAY}`]: DAY }));
    const { scheduler, sent } = makeTab([dateOnly()]);

    setPreferredTimeZone('Asia/Kolkata');
    at('2026-10-20T19:00:00.000Z');
    expect(() => scheduler.runNow()).not.toThrow();

    expect(sent).toEqual([{ id: 'd', type: 'overdue' }]);
  });
});

describe('a reminder that was not delivered (review finding 3)', () => {
  withFakeClock();
  const noteDue = () => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
  };

  it('a throwing delivery withdraws the receipt, does not stop the other tasks, and is retried on the next poll', () => {
    noteDue();
    let failA = true;
    const a = dateOnly({ _id: 'a' });
    const b = dateOnly({ _id: 'b' });
    const { scheduler, sent } = makeTab([a, b], ({ task }) => {
      if (task._id === 'a' && failA) {
        failA = false;
        throw new Error('Illegal constructor');
      }
      return undefined;
    });

    expect(() => scheduler.runNow()).not.toThrow();
    expect(sent).toEqual([{ id: 'b', type: 'due-soon' }]); // b was not held up by a's failure
    expect(receiptKeys()).toEqual([`day:due-soon:b:${DAY}`]); // a's receipt was withdrawn

    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([
      { id: 'b', type: 'due-soon' },
      { id: 'a', type: 'due-soon' },
    ]);
  });

  it('a delivery that reports false (permission revoked, API missing) is retried the same way', () => {
    noteDue();
    let shown = false;
    const { scheduler, sent } = makeTab([dateOnly()], () => shown);

    scheduler.runNow();
    expect(sent).toEqual([]);
    expect(receiptKeys()).toEqual([]);

    shown = true;
    scheduler.runNow();
    scheduler.runNow();
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('gives up after three failed attempts: the receipt stays, so a persistent failure neither loops nor retries later', () => {
    noteDue();
    const deliver = vi.fn(() => false);
    const { scheduler } = makeTab([dateOnly()], deliver);

    for (let i = 0; i < 6; i += 1) scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(receiptKeys()).toEqual([`day:due-soon:d:${DAY}`]);

    sessionStorage.clear(); // and a restart does not start over
    const restarted = vi.fn(() => false);
    makeTab([dateOnly()], restarted).scheduler.runNow();
    expect(restarted).not.toHaveBeenCalled();
  });

  it('a success after earlier failures is delivered once, and the failures do not count against the next reminder', () => {
    noteDue();
    let attempt = 0;
    const { scheduler, sent } = makeTab([dateOnly()], () => (attempt += 1) >= 3);

    for (let i = 0; i < 5; i += 1) scheduler.runNow();

    expect(attempt).toBe(3);
    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('never turns into a stale replay: once the reminder\'s day is over, a reminder that never got through is not sent', () => {
    noteDue();
    const deliver = vi.fn(() => false);
    const { scheduler } = makeTab([dateOnly()], deliver);
    scheduler.runNow(); // one failed attempt, receipt withdrawn
    scheduler.runNow(); // a second
    const before = deliver.mock.calls.length;

    at('2026-10-22T09:00:00.000Z'); // two days on: neither window is open
    scheduler.runNow();
    scheduler.runNow();

    expect(deliver.mock.calls.length).toBe(before);
  });

  it('the next day\'s "overdue" is its own reminder with its own attempts, still inside its own day', () => {
    noteDue();
    const deliver = vi.fn(() => false);
    const { scheduler } = makeTab([dateOnly()], deliver);
    for (let i = 0; i < 4; i += 1) scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3); // due-today gave up

    at('2026-10-21T09:00:00.000Z');
    for (let i = 0; i < 4; i += 1) scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(6); // overdue: three attempts of its own
  });
});

describe('two tabs of one browser (review finding 2)', () => {
  withFakeClock();

  /** A minimal Web Locks: requests run one at a time, in order, like the real API for an exclusive lock. */
  const installLocks = () => {
    let tail: Promise<unknown> = Promise.resolve();
    const state = { holding: false, names: [] as string[] };
    const request = vi.fn((name: string, callback: () => unknown) => {
      state.names.push(name);
      const run = tail.then(async () => {
        state.holding = true;
        try {
          return await callback();
        } finally {
          state.holding = false;
        }
      });
      tail = run.catch(() => undefined);
      return run;
    });
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    return { request, state };
  };
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  beforeEach(() => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
  });

  it('with Web Locks, the receipt check, the write and the delivery all happen while the lock is held', async () => {
    const { request, state } = installLocks();
    const heldWhenDelivered: boolean[] = [];
    const { scheduler, sent } = makeTab([dateOnly()], () => heldWhenDelivered.push(state.holding));

    scheduler.runNow();
    expect(sent).toEqual([]); // queued on the lock, not yet run
    await flush();

    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
    expect(heldWhenDelivered).toEqual([true]);
    expect(request).toHaveBeenCalledWith('halotask-day-reminders', expect.any(Function));
  });

  it('two tabs polling in the same instant send one reminder between them, and nothing more on later polls', async () => {
    installLocks();
    const a = makeTab([dateOnly()]);
    const b = makeTab([dateOnly()]);

    a.scheduler.runNow();
    b.scheduler.runNow();
    await flush();
    a.scheduler.runNow();
    b.scheduler.runNow();
    await flush();

    expect(a.sent.length + b.sent.length).toBe(1);
  });

  it('a failed delivery in one tab is withdrawn under the lock, so the other tab can deliver it', async () => {
    installLocks();
    const a = makeTab([dateOnly()], () => false); // this tab cannot show notifications
    const b = makeTab([dateOnly()]);

    a.scheduler.runNow();
    b.scheduler.runNow();
    await flush();

    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('a lock request that fails does not lose the reminder: the same steps run directly, once', async () => {
    Object.defineProperty(navigator, 'locks', { value: { request: vi.fn(() => Promise.reject(new Error('denied'))) }, configurable: true });
    const { scheduler, sent } = makeTab([dateOnly()]);

    scheduler.runNow();
    await flush();
    scheduler.runNow();
    await flush();

    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('a lock API that throws is treated the same way', async () => {
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: () => {
          throw new Error('SecurityError');
        },
      },
      configurable: true,
    });
    const { scheduler, sent } = makeTab([dateOnly()]);

    scheduler.runNow();
    await flush();

    expect(sent).toEqual([{ id: 'd', type: 'due-soon' }]);
  });

  it('a lock that rejects after the section ran does not run it a second time (no extra delivery attempt)', async () => {
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: (_name: string, callback: () => unknown) => {
          callback();
          return Promise.reject(new Error('released badly'));
        },
      },
      configurable: true,
    });
    // A failing delivery withdraws its receipt, so only the "already ran" guard can stop a second attempt here.
    const deliver = vi.fn(() => false);
    const { scheduler } = makeTab([dateOnly()], deliver);

    scheduler.runNow();
    await flush();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('without the Web Locks API the same steps run at once and still read the other tab\'s receipts (best-effort across tabs)', () => {
    expect('locks' in navigator).toBe(false); // jsdom: this is the fallback path
    const a = makeTab([dateOnly()]);
    const b = makeTab([dateOnly()]);

    a.scheduler.runNow();
    expect(a.sent).toEqual([{ id: 'd', type: 'due-soon' }]); // synchronous
    b.scheduler.runNow(); // another tab, later: reads a's receipt from localStorage
    expect(b.sent).toEqual([]);
  });
});

// ── Persistent retry budget ──────────────────────────────────────────────────────────────────────────────────────
// The three-attempt cap must hold across page reloads, recreated schedulers and tabs. A "reload" below is what the
// browser does: localStorage survives, sessionStorage is gone, and a brand-new scheduler starts from nothing.

const ATTEMPTS_KEY = 'halotask_day_reminder_attempts';
const DUE_KEY = `day:due-soon:d:${DAY}`;
const OVERDUE_KEY = `day:overdue:d:${DAY}`;
const storedAttempts = () => JSON.parse(localStorage.getItem(ATTEMPTS_KEY) ?? '{}') as Record<string, { day: string; n: number }>;
const storedReceipts = () => JSON.parse(localStorage.getItem(RECEIPTS_KEY) ?? '{}') as Record<string, Record<string, unknown>>;
const reload = (tasks: Task[], deliver?: (event: { task: Task; type: string }) => unknown) => {
  sessionStorage.clear();
  return makeTab(tasks, deliver);
};

describe('the delivery retry budget is durable (persistent attempts)', () => {
  withFakeClock();

  beforeEach(() => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
  });

  it('a failed attempt is counted across scheduler recreation', () => {
    const deliver = vi.fn(() => false);

    makeTab([dateOnly()], deliver).scheduler.runNow();
    expect(storedAttempts()[DUE_KEY]).toEqual({ day: DAY, n: 1 });

    reload([dateOnly()], deliver).scheduler.runNow();
    expect(storedAttempts()[DUE_KEY]).toEqual({ day: DAY, n: 2 });
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it('two failures, a recreation, and another failure reach the cap; nothing is attempted after it', () => {
    const deliver = vi.fn(() => false);
    const first = makeTab([dateOnly()], deliver);
    first.scheduler.runNow();
    first.scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(2);

    const second = reload([dateOnly()], deliver);
    second.scheduler.runNow(); // the third failure
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
    expect(Object.keys(storedReceipts())).toEqual([DUE_KEY]); // the receipt is kept: the reminder is spent

    second.scheduler.runNow();
    reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('repeated recreation cannot bypass the cap', () => {
    const deliver = vi.fn(() => false);

    for (let i = 0; i < 12; i += 1) {
      const tab = reload([dateOnly()], deliver);
      tab.scheduler.runNow();
      tab.scheduler.runNow();
    }

    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('a successful delivery retires the retry state, and the reminder is not sent again', () => {
    let calls = 0;
    const deliver = vi.fn(() => (calls += 1) >= 3); // fails twice, then gets through
    const sentIds: string[] = [];
    const tasks = [dateOnly()];

    const first = makeTab(tasks, deliver);
    first.scheduler.runNow();
    reload(tasks, deliver).scheduler.runNow();
    expect(storedAttempts()[DUE_KEY].n).toBe(2);

    const third = reload(tasks, deliver);
    third.scheduler.runNow();
    sentIds.push(...third.sent.map((s) => s.id));

    expect(sentIds).toEqual(['d']);
    expect(storedAttempts()[DUE_KEY]).toBeUndefined(); // retired
    expect(Object.keys(storedReceipts())).toEqual([DUE_KEY]);

    reload(tasks, deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('due-today and overdue have independent budgets', () => {
    const deliver = vi.fn(() => false);
    for (let i = 0; i < 5; i += 1) reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3); // due-today spent its three on the due day

    at('2026-10-21T09:00:00.000Z'); // the day after: the overdue reminder has a budget of its own
    for (let i = 0; i < 5; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(6);
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
    expect(storedAttempts()[OVERDUE_KEY].n).toBe(3);
  });

  it('retry state is per task: one task\'s spent budget does not limit another', () => {
    const deliver = vi.fn(({ task }: { task: Task }) => task._id !== 'b');
    const tasks = [dateOnly({ _id: 'a' }), dateOnly({ _id: 'b' })];

    for (let i = 0; i < 5; i += 1) reload(tasks, deliver).scheduler.runNow();

    expect(deliver.mock.calls.filter(([e]) => e.task._id === 'b')).toHaveLength(3);
    expect(deliver.mock.calls.filter(([e]) => e.task._id === 'a')).toHaveLength(1); // delivered once, never again
  });

  it('prunes retry state on the receipts\' retention (3 days) and ignores malformed entries', () => {
    localStorage.setItem(
      ATTEMPTS_KEY,
      JSON.stringify({
        'day:due-soon:gone:2026-10-16': { day: '2026-10-16', n: 3 }, // 4 days old: pruned
        'day:overdue:kept:2026-10-17': { day: '2026-10-17', n: 2 }, // exactly 3 days old: kept
        'day:due-soon:bad-count:2026-10-20': { day: DAY, n: 0 },
        'day:due-soon:bad-type:2026-10-20': { day: DAY, n: '3' },
        'day:due-soon:no-day:2026-10-20': { n: 2 },
        'day:due-soon:null:2026-10-20': null,
      }),
    );

    reload([dateOnly()], () => false).scheduler.runNow(); // a claim runs the pruning

    expect(Object.keys(storedAttempts()).sort()).toEqual([DUE_KEY, 'day:overdue:kept:2026-10-17'].sort());
  });

  it('a reminder whose window has passed is never replayed, and its leftover state is not mistaken for a budget', () => {
    const deliver = vi.fn(() => false);
    makeTab([dateOnly()], deliver).scheduler.runNow();
    reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(2); // two failures, receipt withdrawn, one attempt left

    at('2026-10-22T09:00:00.000Z'); // two days after the due day: neither window is open
    for (let i = 0; i < 3; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(storedAttempts()[DUE_KEY].n).toBe(2); // untouched until it ages out
  });

  it('a spent budget blocks the reminder even when its receipt is gone; an unspent one allows exactly the attempts left', () => {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ [DUE_KEY]: { day: DAY, n: 3 } }));
    const spent = vi.fn(() => false);
    reload([dateOnly()], spent).scheduler.runNow();
    expect(spent).not.toHaveBeenCalled();

    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ [DUE_KEY]: { day: DAY, n: 2 } }));
    const oneLeft = vi.fn(() => false);
    for (let i = 0; i < 4; i += 1) reload([dateOnly()], oneLeft).scheduler.runNow();
    expect(oneLeft).toHaveBeenCalledTimes(1);
  });

  it('the receipts keep exactly their old shape: retry bookkeeping never leaks into halotask_day_reminders', () => {
    const deliver = vi.fn(() => false);
    makeTab([dateOnly()], deliver).scheduler.runNow();
    expect(storedReceipts()).toEqual({}); // withdrawn for a retry: no entry, and no attempt fields

    for (let i = 0; i < 3; i += 1) reload([dateOnly()], deliver).scheduler.runNow();
    const receipt = storedReceipts()[DUE_KEY];
    expect(Object.keys(receipt).sort()).toEqual(['at', 'day']);
  });

  it('existing receipts in either stored shape are honoured, and a corrupt attempts record reads as "no failures"', () => {
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify({ [DUE_KEY]: DAY })); // the earlier format: a bare due day
    const deliver = vi.fn(() => true);
    reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).not.toHaveBeenCalled(); // already sent: still de-duplicated
    expect(localStorage.getItem(ATTEMPTS_KEY)).toBeNull(); // and no retry state was invented

    localStorage.clear();
    localStorage.setItem(ATTEMPTS_KEY, '{not json');
    const failing = vi.fn(() => false);
    expect(() => reload([dateOnly()], failing).scheduler.runNow()).not.toThrow();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(storedAttempts()[DUE_KEY]).toEqual({ day: DAY, n: 1 }); // rewritten as valid state

    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify([1, 2, 3]));
    expect(() => reload([dateOnly()], failing).scheduler.runNow()).not.toThrow();
  });

  it('exact-time reminders are not budgeted: they keep their once-per-session behaviour and leave no retry state', () => {
    const timed = makeTask({ _id: 'timed', dueDate: STORED, dueTime: '17:30' });
    at(`${DAY}T16:45:00.000Z`);
    const deliver = vi.fn(() => false);

    const first = makeTab([timed], deliver);
    first.scheduler.runNow();
    first.scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(1); // once per session, as before, whatever it returned

    reload([timed], deliver).scheduler.runNow(); // a new session re-sends, as before
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(localStorage.getItem(ATTEMPTS_KEY)).toBeNull();
  });

  it('a spent due-today reminder still blocks an "overdue" that only a zone change would cause', () => {
    setPreferredTimeZone('America/Los_Angeles');
    at('2026-10-20T19:00:00.000Z'); // 12:00 on the due day in Los Angeles
    const deliver = vi.fn(() => false);
    for (let i = 0; i < 3; i += 1) reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);

    setPreferredTimeZone('Asia/Kolkata'); // 00:30 on the 21st: overdue there
    for (let i = 0; i < 3; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(3);
  });
});

describe('the retry budget is shared by tabs and kept inside the critical section', () => {
  withFakeClock();

  const installLocks = () => {
    let tail: Promise<unknown> = Promise.resolve();
    const state = { holding: false };
    const request = (_name: string, callback: () => unknown) => {
      const run = tail.then(async () => {
        state.holding = true;
        try {
          return await callback();
        } finally {
          state.holding = false;
        }
      });
      tail = run.catch(() => undefined);
      return run;
    };
    Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
    return state;
  };

  beforeEach(() => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
  });
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
    vi.restoreAllMocks();
    resetDayReminderFallback(); // the in-memory fallback is module state: a test that used it must not leak it
  });

  it('with Web Locks, every tab draws on one budget: three attempts in total, not three per tab', async () => {
    installLocks();
    const deliver = vi.fn(() => false);
    const tabs = [makeTab([dateOnly()], deliver), makeTab([dateOnly()], deliver), makeTab([dateOnly()], deliver)];

    for (let round = 0; round < 4; round += 1) {
      tabs.forEach((tab) => tab.scheduler.runNow());
      await flush();
    }

    expect(deliver).toHaveBeenCalledTimes(3);
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
  });

  it('the attempt count and the receipt are both written while the lock is held', async () => {
    const lock = installLocks();
    const original = Storage.prototype.setItem;
    const writes: { key: string; holding: boolean }[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage) writes.push({ key, holding: lock.holding });
      return original.call(this, key, value);
    });
    const { scheduler } = makeTab([dateOnly()], () => false);

    scheduler.runNow();
    await flush();

    const ours = writes.filter((w) => w.key === ATTEMPTS_KEY || w.key === RECEIPTS_KEY);
    expect(ours.some((w) => w.key === ATTEMPTS_KEY)).toBe(true);
    expect(ours.some((w) => w.key === RECEIPTS_KEY)).toBe(true);
    expect(ours.every((w) => w.holding)).toBe(true);
  });

  it('a failure is counted before its receipt is withdrawn, so an interruption between the two cannot grant extra attempts', async () => {
    const original = Storage.prototype.setItem;
    const order: string[] = [];
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage && (key === ATTEMPTS_KEY || key === RECEIPTS_KEY)) {
        const receipts = key === RECEIPTS_KEY ? (JSON.parse(value) as Record<string, unknown>) : null;
        order.push(key === ATTEMPTS_KEY ? 'attempts' : receipts && DUE_KEY in receipts ? 'receipt-claimed' : 'receipt-withdrawn');
      }
      return original.call(this, key, value);
    });

    makeTab([dateOnly()], () => false).scheduler.runNow();

    expect(order).toEqual(['receipt-claimed', 'attempts', 'receipt-withdrawn']);
  });

  it('without Web Locks, tabs that run one after another still share the budget (best-effort: simultaneous polls are not guarded)', () => {
    expect('locks' in navigator).toBe(false);
    const deliver = vi.fn(() => false);
    const a = makeTab([dateOnly()], deliver);
    const b = makeTab([dateOnly()], deliver);

    for (let round = 0; round < 4; round += 1) {
      a.scheduler.runNow();
      b.scheduler.runNow();
    }

    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('when localStorage cannot be used the tab still enforces the cap from its own memory', () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === localStorage) throw new Error('storage unavailable');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage) throw new Error('storage unavailable');
      return setItem.call(this, key, value);
    });
    const deliver = vi.fn(() => false);
    const { scheduler } = makeTab([dateOnly()], deliver);

    for (let i = 0; i < 6; i += 1) scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(3);
  });
});

describe('when localStorage refuses writes, the in-memory fallback is shared by every scheduler of the page', () => {
  withFakeClock();

  beforeEach(() => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetDayReminderFallback();
  });

  /** localStorage that throws on every write, and on every read too unless `readsWork`. */
  const breakLocalStorage = (readsWork = false) => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    if (!readsWork) {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
        if (this === localStorage) throw new Error('storage unavailable');
        return getItem.call(this, key);
      });
    }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage) throw new Error('storage unavailable');
      return setItem.call(this, key, value);
    });
  };
  /** A recreated scheduler in the SAME page: nothing is cleared, nothing is reloaded. */
  const recreate = (deliver: (event: { task: Task; type: string }) => unknown) => makeTab([dateOnly()], deliver);

  it('two failures, then the scheduler is recreated without a reload: only one further attempt is allowed, however many instances follow', () => {
    breakLocalStorage();
    const deliver = vi.fn(() => false);

    const first = recreate(deliver);
    first.scheduler.runNow();
    first.scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(2);

    const second = recreate(deliver);
    second.scheduler.runNow(); // the one attempt that is left
    second.scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);

    for (let i = 0; i < 6; i += 1) {
      const next = recreate(deliver);
      next.scheduler.runNow();
      next.scheduler.runNow();
    }
    first.scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('a reminder that was delivered is not sent again by a recreated scheduler', () => {
    breakLocalStorage();
    const deliver = vi.fn(() => true);

    for (let i = 0; i < 4; i += 1) recreate(deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('a failed attempt hands its reminder to the next scheduler to retry, and a delivered one stays delivered', () => {
    breakLocalStorage();
    let calls = 0;
    const deliver = vi.fn(() => (calls += 1) >= 2);

    const a = recreate(deliver);
    a.scheduler.runNow(); // fails
    const b = recreate(deliver);
    b.scheduler.runNow(); // retries and gets through
    const c = recreate(deliver);
    c.scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(2);
    expect(a.sent).toEqual([]);
    expect(b.sent).toEqual([{ id: 'd', type: 'due-soon' }]);
    expect(c.sent).toEqual([]);
  });

  it('reads that work cannot undo what writes could not store: a stale stored count never lowers the in-memory one', () => {
    localStorage.setItem(ATTEMPTS_KEY, JSON.stringify({ [DUE_KEY]: { day: DAY, n: 1 } }));
    breakLocalStorage(true);
    const deliver = vi.fn(() => false);

    for (let i = 0; i < 5; i += 1) recreate(deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(2); // 1 stored + these 2 = the cap of 3
    expect(storedAttempts()[DUE_KEY].n).toBe(1); // storage still holds the stale count; the context remembers the real one
  });

  it('when storage works again the state moves back into it, and the budget carries over a reload from there', () => {
    breakLocalStorage();
    const deliver = vi.fn(() => false);
    recreate(deliver).scheduler.runNow(); // counted in memory only

    vi.restoreAllMocks(); // storage is back
    expect(localStorage.getItem(ATTEMPTS_KEY)).toBeNull(); // nothing was written while it was down
    recreate(deliver).scheduler.runNow(); // reads the in-memory count, stores the new one
    expect(storedAttempts()[DUE_KEY].n).toBe(2);

    resetDayReminderFallback(); // a page reload: only storage is left
    sessionStorage.clear();
    recreate(deliver).scheduler.runNow();
    recreate(deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('the fallback does not survive a page reload (the documented limit): the budget starts over', () => {
    breakLocalStorage();
    const deliver = vi.fn(() => false);
    for (let i = 0; i < 4; i += 1) recreate(deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);

    resetDayReminderFallback(); // what a reload does to module state
    sessionStorage.clear();
    recreate(deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(4);
  });

  /** Receipt writes succeed until the first `okWrites` have happened, then fail; reads and attempt writes always work. */
  const failReceiptWritesAfter = (okWrites: number) => {
    const setItem = Storage.prototype.setItem;
    let receiptWrites = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage && key === RECEIPTS_KEY && (receiptWrites += 1) > okWrites) throw new Error('quota exceeded');
      return setItem.call(this, key, value);
    });
  };

  it('a withdrawal that could not be stored is not undone by the stale stored receipt: retries continue within the budget, and the cap holds', () => {
    failReceiptWritesAfter(1); // the claim is stored; the withdrawal and everything after it is not
    const deliver = vi.fn(() => false);

    recreate(deliver).scheduler.runNow(); // claim stored, delivery fails, withdrawal refused
    expect(Object.keys(storedReceipts())).toEqual([DUE_KEY]); // the stale receipt is still in storage

    for (let i = 0; i < 6; i += 1) recreate(deliver).scheduler.runNow(); // reads work: they see the stale receipt

    expect(deliver).toHaveBeenCalledTimes(3); // all three attempts happened; never a fourth
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
  });

  it('only the receipt that was withdrawn is hidden: a newer receipt written by another tab still de-duplicates', () => {
    failReceiptWritesAfter(1);
    const deliver = vi.fn(() => false);
    recreate(deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(1);

    // Another tab, with working storage, delivered the reminder after our withdrawal failed.
    vi.restoreAllMocks(); // (this test's own write must go through)
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify({ [DUE_KEY]: { day: DAY, at: Date.now() + 60_000 } }));
    recreate(deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('when storage is writable again after a failed withdrawal, a retry that is delivered is stored and not sent again', () => {
    failReceiptWritesAfter(1);
    let calls = 0;
    const deliver = vi.fn(() => (calls += 1) >= 2); // the first attempt fails, the second gets through

    recreate(deliver).scheduler.runNow(); // fails; withdrawal not stored
    vi.restoreAllMocks(); // storage is writable again
    const retry = recreate(deliver);
    retry.scheduler.runNow(); // retried and delivered, receipt stored

    expect(retry.sent).toEqual([{ id: 'd', type: 'due-soon' }]);
    expect(storedReceipts()[DUE_KEY]).toBeDefined();

    // Same page, no reload: the retry's receipt (even at the very same instant as the withdrawn one) must count.
    for (let i = 0; i < 3; i += 1) recreate(deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(2);

    resetDayReminderFallback(); // a reload
    sessionStorage.clear();
    for (let i = 0; i < 3; i += 1) recreate(deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(2); // deduplicated from storage alone
  });

  /**
   * Storage whose receipt WRITES fail after the first `okWrites`, and whose receipt READS are down from the first failed
   * write until `recoverReads()`; with `writesBack()` writes work again. Attempt records are always readable/writable.
   */
  const flakyReceiptStorage = (okWrites: number) => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    const state = { writes: 0, readsDown: false, restored: false };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === localStorage && key === RECEIPTS_KEY && state.readsDown) throw new Error('read failed');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage && key === RECEIPTS_KEY && !state.restored && state.writes >= okWrites) {
        state.readsDown = true; // the same outage takes reads down with the writes
        throw new Error('write failed');
      }
      if (this === localStorage && key === RECEIPTS_KEY) state.writes += 1;
      return setItem.call(this, key, value);
    });
    return {
      recoverReads: () => {
        state.readsDown = false;
      },
      writesBack: () => {
        state.readsDown = false;
        state.restored = true;
      },
    };
  };

  it('a withdrawal refused while reads are also down is still remembered when reads recover: retries use the remaining budget and never exceed it', () => {
    const storage = flakyReceiptStorage(1); // the claim is stored, then writes AND reads go down
    const deliver = vi.fn(() => false);

    recreate(deliver).scheduler.runNow(); // attempt 1: claim stored, delivery fails, withdrawal refused, reads down
    at(`${DAY}T09:01:00.000Z`); // a later poll: attempt 2 carries a different receipt time than attempt 1
    recreate(deliver).scheduler.runNow(); // attempt 2, still with reads down
    expect(deliver).toHaveBeenCalledTimes(2);

    storage.recoverReads(); // reads are back and show the stale receipt of attempt 1 (an earlier time); writes still fail
    expect(Object.keys(storedReceipts())).toEqual([DUE_KEY]);
    for (let i = 0; i < 6; i += 1) recreate(deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(3); // the one attempt that was left, and never a fourth
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
  });

  it('a newer receipt from another tab still de-duplicates after a withdrawal was refused during a read outage', () => {
    const storage = flakyReceiptStorage(1);
    const deliver = vi.fn(() => false);
    recreate(deliver).scheduler.runNow(); // refused withdrawal, reads down
    storage.writesBack(); // and the other tab delivers it:
    localStorage.setItem(RECEIPTS_KEY, JSON.stringify({ [DUE_KEY]: { day: DAY, at: Date.now() + 60_000 } }));

    recreate(deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('when writes come back after that outage, a delivered retry is stored and de-duplicated, in the page and after a reload', () => {
    const storage = flakyReceiptStorage(1);
    let calls = 0;
    const deliver = vi.fn(() => (calls += 1) >= 3); // two failures, then it gets through

    recreate(deliver).scheduler.runNow(); // attempt 1 fails; reads and writes down
    recreate(deliver).scheduler.runNow(); // attempt 2 fails
    storage.recoverReads();
    storage.writesBack(); // storage fully works again
    const retry = recreate(deliver);
    retry.scheduler.runNow(); // attempt 3 delivers

    expect(retry.sent).toEqual([{ id: 'd', type: 'due-soon' }]);
    expect(storedReceipts()[DUE_KEY]).toBeDefined();
    expect(storedAttempts()[DUE_KEY]).toBeUndefined(); // retired by the success

    for (let i = 0; i < 3; i += 1) recreate(deliver).scheduler.runNow();
    resetDayReminderFallback(); // a reload
    sessionStorage.clear();
    for (let i = 0; i < 3; i += 1) recreate(deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('with working storage the fallback stays out of it: storage is the only truth, and nothing is resurrected from memory', () => {
    const deliver = vi.fn(() => false);
    recreate(deliver).scheduler.runNow();
    expect(storedAttempts()[DUE_KEY].n).toBe(1);

    localStorage.clear(); // site data cleared while the page stays open
    recreate(deliver).scheduler.runNow();

    expect(storedAttempts()[DUE_KEY].n).toBe(1); // a fresh count, not 2
  });
});

// ── Unreadable attempts record ───────────────────────────────────────────────────────────────────────────────────
// A failed READ of the attempts record is not proof that no attempts happened. When reads of it fail but writes work,
// counting from zero would write over a higher stored count and reset the budget; the reminder is held instead.

describe('an unreadable attempts record never resets or exceeds the retry budget', () => {
  withFakeClock();

  const PROBE_KEY = 'halotask_day_reminder_probe';

  beforeEach(() => {
    setPreferredTimeZone('UTC');
    at(`${DAY}T09:00:00.000Z`);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetDayReminderFallback();
  });

  const seedAttempts = (attempts: Record<string, { day: string; n: number }>) => localStorage.setItem(ATTEMPTS_KEY, JSON.stringify(attempts));

  /** Reads of the attempts key throw while `down.reads` is true; writes always work. */
  const attemptsReadsDown = () => {
    const getItem = Storage.prototype.getItem;
    const down = {
      reads: true,
      /** What is really stored, read around the outage. */
      peek: () => JSON.parse(getItem.call(localStorage, ATTEMPTS_KEY) ?? '{}') as Record<string, { day: string; n: number }>,
    };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === localStorage && key === ATTEMPTS_KEY && down.reads) throw new Error('read failed');
      return getItem.call(this, key);
    });
    return down;
  };

  it('a stored count of 2 survives a read outage: nothing is attempted, nothing is overwritten, and after recovery exactly one attempt is left', () => {
    seedAttempts({ [DUE_KEY]: { day: DAY, n: 2 } });
    const down = attemptsReadsDown();
    const deliver = vi.fn(() => false);

    for (let i = 0; i < 5; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).not.toHaveBeenCalled(); // the budget could not be established: held, not granted
    expect(down.peek()).toEqual({ [DUE_KEY]: { day: DAY, n: 2 } }); // untouched, not reset to 1
    expect(storedReceipts()).toEqual({}); // and no receipt was claimed

    down.reads = false; // reads recover
    for (let i = 0; i < 5; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(1); // the one attempt that was left
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
  });

  it('a genuinely missing attempts record still permits the initial attempt, and an empty record is not an outage', () => {
    expect(localStorage.getItem(ATTEMPTS_KEY)).toBeNull();
    const deliver = vi.fn(() => false);

    reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(storedAttempts()[DUE_KEY].n).toBe(1);

    localStorage.setItem(ATTEMPTS_KEY, '{}'); // present but empty
    const other = vi.fn(() => false);
    reload([dateOnly({ _id: 'other' })], other).scheduler.runNow();
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('an unreadable record does not overwrite the budgets of unrelated tasks, and each keeps its own count after recovery', () => {
    const budgets = {
      [`day:due-soon:a:${DAY}`]: { day: DAY, n: 2 },
      [`day:due-soon:b:${DAY}`]: { day: DAY, n: 1 },
      [`day:overdue:c:2026-10-19`]: { day: '2026-10-19', n: 2 },
    };
    seedAttempts(budgets);
    const down = attemptsReadsDown();
    const deliver = vi.fn((_event: { task: Task; type: string }) => false);
    const tasks = [dateOnly({ _id: 'a' }), dateOnly({ _id: 'b' }), dateOnly({ _id: 'new' })];

    for (let i = 0; i < 3; i += 1) reload(tasks, deliver).scheduler.runNow();
    expect(deliver).not.toHaveBeenCalled(); // not even the task with no record at all: nothing can be established
    expect(down.peek()).toEqual(budgets);

    down.reads = false;
    for (let i = 0; i < 6; i += 1) reload(tasks, deliver).scheduler.runNow();

    const perTask = (id: string) => deliver.mock.calls.filter(([event]) => event.task._id === id).length;
    expect(perTask('a')).toBe(1); // 2 stored + 1
    expect(perTask('b')).toBe(2); // 1 stored + 2
    expect(perTask('new')).toBe(3);
    expect(storedAttempts()[`day:overdue:c:2026-10-19`]).toEqual({ day: '2026-10-19', n: 2 }); // untouched
  });

  it('recovery creates no duplicate notification: a reminder delivered after the outage is sent once, and stays sent', () => {
    seedAttempts({ [DUE_KEY]: { day: DAY, n: 2 } });
    const down = attemptsReadsDown();
    const deliver = vi.fn(() => true);

    for (let i = 0; i < 3; i += 1) reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).not.toHaveBeenCalled();

    down.reads = false;
    for (let i = 0; i < 4; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(storedAttempts()[DUE_KEY]).toBeUndefined(); // retired by the success
    expect(Object.keys(storedReceipts())).toEqual([DUE_KEY]);
  });

  it('an outage that lasts a single poll holds that poll and loses nothing', () => {
    seedAttempts({ [DUE_KEY]: { day: DAY, n: 2 } });
    const getItem = Storage.prototype.getItem;
    let failNextRead = true;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === localStorage && key === ATTEMPTS_KEY && failNextRead) {
        failNextRead = false;
        throw new Error('transient');
      }
      return getItem.call(this, key);
    });
    const deliver = vi.fn(() => false);

    const tab = reload([dateOnly()], deliver);
    tab.scheduler.runNow(); // the read fails: held
    expect(deliver).not.toHaveBeenCalled();
    tab.scheduler.runNow(); // the read works: the third attempt
    tab.scheduler.runNow(); // and the cap holds

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(storedAttempts()[DUE_KEY].n).toBe(3);
  });

  it('due-today and overdue stay separate under an outage: a spent due-today budget does not hold or spend the overdue one', () => {
    seedAttempts({ [DUE_KEY]: { day: DAY, n: 3 } });
    at('2026-10-21T09:00:00.000Z'); // the day after: the overdue reminder
    const down = attemptsReadsDown();
    const deliver = vi.fn(() => false);

    reload([dateOnly()], deliver).scheduler.runNow();
    expect(deliver).not.toHaveBeenCalled(); // held while unreadable

    down.reads = false;
    for (let i = 0; i < 5; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(3); // overdue has its own fresh budget of three
    expect(storedAttempts()[DUE_KEY].n).toBe(3); // due-today's spent budget is untouched
    expect(storedAttempts()[OVERDUE_KEY].n).toBe(3);
  });

  it('the probe leaves nothing behind, and a held poll writes nothing of the reminder\'s own', () => {
    seedAttempts({ [DUE_KEY]: { day: DAY, n: 1 } });
    attemptsReadsDown();
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    reload([dateOnly()], vi.fn(() => false)).scheduler.runNow();

    const written = setItem.mock.calls.filter(([key]) => key !== undefined).map(([key]) => key);
    expect(written.every((key) => key === PROBE_KEY)).toBe(true);
    expect(localStorage.getItem(PROBE_KEY)).toBeNull();
  });

  it('when storage is down for reads AND writes, nothing stored can be overwritten, so the in-memory cap still applies', () => {
    const getItem = Storage.prototype.getItem;
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (this === localStorage) throw new Error('storage unavailable');
      return getItem.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage) throw new Error('storage unavailable');
      return setItem.call(this, key, value);
    });
    const deliver = vi.fn(() => false);

    for (let i = 0; i < 6; i += 1) reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('a corrupt attempts record is readable data that cannot be used: it reads as "no failures yet" and is rewritten', () => {
    localStorage.setItem(ATTEMPTS_KEY, '{not json');
    const deliver = vi.fn(() => false);

    reload([dateOnly()], deliver).scheduler.runNow();

    expect(deliver).toHaveBeenCalledTimes(1);
    expect(storedAttempts()[DUE_KEY]).toEqual({ day: DAY, n: 1 });
  });

  it('a record that parses but is not an attempts object (array, null, number, string) is readable too: the initial attempt is permitted and the record rewritten', () => {
    for (const stored of ['[1,2,3]', 'null', '42', '"text"']) {
      localStorage.clear();
      localStorage.setItem(ATTEMPTS_KEY, stored);
      const deliver = vi.fn(() => false);

      reload([dateOnly()], deliver).scheduler.runNow();

      expect(deliver, stored).toHaveBeenCalledTimes(1);
      expect(storedAttempts()[DUE_KEY], stored).toEqual({ day: DAY, n: 1 });
    }
  });
});
