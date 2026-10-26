import { afterEach, describe, expect, it } from 'vitest';
import { clockOf } from '../test/localeText';
import { inTimeZone, makeTask, TIME_ZONES } from '../test/taskFactory';
import { setPreferredTimeZone } from '../utils/timeZone';
import { getDeadlineMs, getSmartStartWindows, getTasksDueInNextHour, getTasksOverdueNow, reminderSchedulePart } from './deadlineLogic';
import { getReminderPayload } from './notification';

// Issue #41 — reminders read an exact deadline in the same zone as the deadline utilities, and a date-only task keeps
// its legacy behaviour in every zone (Issue #42 owns changing that).

afterEach(() => setPreferredTimeZone(null));

const utc = (iso: string) => Date.parse(iso);
const ids = (tasks: { _id: string }[]) => tasks.map((t) => t._id);
const DUE = '2026-10-20T00:00:00.000Z';

describe('exact deadlines follow the preferred zone', () => {
  const timed = makeTask({ _id: 'timed', dueDate: DUE, dueTime: '17:30' });

  it.each([
    ['UTC', '2026-10-20T17:30:00.000Z'],
    ['Asia/Kolkata', '2026-10-20T12:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-21T00:30:00.000Z'],
    ['Pacific/Kiritimati', '2026-10-20T03:30:00.000Z'],
    ['Pacific/Pago_Pago', '2026-10-21T04:30:00.000Z'],
  ])('%s: the reminder deadline is %s, whatever the machine\'s zone', (zone, expected) => {
    for (const machine of ['UTC', 'America/Los_Angeles']) {
      inTimeZone(machine, () => {
        setPreferredTimeZone(zone);
        expect(getDeadlineMs(timed)).toBe(utc(expected));
      });
    }
  });

  it('"due soon" and "overdue" switch at the zone\'s deadline, not at the machine\'s', () => {
    inTimeZone('America/Los_Angeles', () => {
      setPreferredTimeZone('Asia/Kolkata'); // deadline 12:00Z
      expect(ids(getTasksDueInNextHour([timed], utc('2026-10-20T11:00:01.000Z')))).toEqual(['timed']);
      expect(ids(getTasksDueInNextHour([timed], utc('2026-10-20T10:59:59.000Z')))).toEqual([]);
      expect(ids(getTasksOverdueNow([timed], utc('2026-10-20T11:59:59.000Z')))).toEqual([]);
      expect(ids(getTasksOverdueNow([timed], utc('2026-10-20T12:00:00.000Z')))).toEqual(['timed']);

      setPreferredTimeZone('America/Los_Angeles'); // deadline 00:30Z on the 21st
      expect(ids(getTasksOverdueNow([timed], utc('2026-10-20T12:00:00.000Z')))).toEqual([]);
      expect(ids(getTasksOverdueNow([timed], utc('2026-10-21T00:30:00.000Z')))).toEqual(['timed']);
    });
  });

  it('the deadline of a due time in the spring-forward gap is the later hour; in the repeated hour, the first', () => {
    setPreferredTimeZone('America/Los_Angeles');
    expect(getDeadlineMs(makeTask({ dueDate: '2026-03-08T00:00:00.000Z', dueTime: '02:30' }))).toBe(utc('2026-03-08T10:30:00.000Z'));
    expect(getDeadlineMs(makeTask({ dueDate: '2026-11-01T00:00:00.000Z', dueTime: '01:30' }))).toBe(utc('2026-11-01T08:30:00.000Z'));
  });
});

describe('a start time is an instant: no zone moves it', () => {
  it('the start window is the same under every preference; only the exact deadline that ends it moves', () => {
    const task = makeTask({ _id: 's', startTime: '2026-10-20T09:30:00.000Z', dueDate: DUE, dueTime: '17:30' });
    const starts = new Set<number>();
    const ends = new Map<string, number>();

    for (const zone of TIME_ZONES) {
      setPreferredTimeZone(zone);
      const [window] = getSmartStartWindows([task], utc('2026-10-19T12:00:00.000Z'));
      starts.add(window.latestStartTime);
      ends.set(zone, window.windowEndTime);
      expect(window.notifyAtTime).toBe(window.latestStartTime - 3_600_000);
    }

    expect([...starts]).toEqual([utc('2026-10-20T09:30:00.000Z')]);
    expect(ends.get('Asia/Kolkata')).toBe(utc('2026-10-20T12:00:00.000Z'));
    expect(ends.get('America/Los_Angeles')).toBe(utc('2026-10-21T00:30:00.000Z'));
  });

  it('a start time with no due time gives the same window in every zone', () => {
    const task = makeTask({ startTime: '2026-10-20T09:30:00.000Z' });
    const windows = TIME_ZONES.map((zone) => {
      setPreferredTimeZone(zone);
      return getSmartStartWindows([task], utc('2026-10-20T08:00:00.000Z'))[0];
    });
    expect(new Set(windows.map((w) => `${w.latestStartTime}/${w.windowEndTime}`)).size).toBe(1);
  });
});

describe('date-only tasks: the legacy UTC-midnight reminder is unchanged in every zone (Issue #42 is separate)', () => {
  const dateOnly = makeTask({ _id: 'date-only', dueDate: DUE });

  it.each(TIME_ZONES)('%s: the reminder deadline is still UTC midnight of the due day', (zone) => {
    for (const machine of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      inTimeZone(machine, () => {
        setPreferredTimeZone(zone);
        expect(getDeadlineMs(dateOnly)).toBe(utc('2026-10-20T00:00:00.000Z'));
        expect(ids(getTasksOverdueNow([dateOnly], utc('2026-10-19T23:59:59.000Z')))).toEqual([]);
        expect(ids(getTasksOverdueNow([dateOnly], utc('2026-10-20T00:00:00.000Z')))).toEqual(['date-only']);
      });
    }
  });

  it('its schedule identity carries no zone, so changing the zone does not re-arm or re-send anything', () => {
    setPreferredTimeZone('Asia/Kolkata');
    const before = reminderSchedulePart(dateOnly);
    setPreferredTimeZone('America/Los_Angeles');
    expect(reminderSchedulePart(dateOnly)).toBe(before);
    expect(before).toBe(DUE);
  });
});

describe('reminder identity', () => {
  it('a timed task\'s schedule includes its zone: moving the zone moves the deadline, so the reminder is re-armed', () => {
    const task = makeTask({ dueDate: DUE, dueTime: '17:30' });
    setPreferredTimeZone('Asia/Kolkata');
    const kolkata = reminderSchedulePart(task);
    setPreferredTimeZone('America/Los_Angeles');
    const la = reminderSchedulePart(task);

    expect(kolkata).toBe(`${DUE}:t17:30@Asia/Kolkata`);
    expect(la).toBe(`${DUE}:t17:30@America/Los_Angeles`);
    expect(getReminderPayload(task, 'overdue').tag).toContain('America/Los_Angeles');
  });

  it('the same zone and the same task give the same identity again (retries and syncs send nothing twice)', () => {
    const task = makeTask({ dueDate: DUE, dueTime: '17:30' });
    setPreferredTimeZone('Asia/Kolkata');
    expect(reminderSchedulePart({ ...task, title: 'renamed' })).toBe(reminderSchedulePart(task));
  });

  it('a start-only task\'s schedule carries no zone', () => {
    setPreferredTimeZone('Asia/Kolkata');
    expect(reminderSchedulePart(makeTask({ startTime: '2026-10-20T09:30:00.000Z' }))).toBe('no-due-date:s2026-10-20T09:30:00.000Z');
  });
});

describe('the start-now notification names the deadline time in the preferred zone, not the device\'s', () => {
  // The device is Los Angeles. For every preference except Los Angeles itself, formatting the deadline instant in the
  // device's zone would give a different clock reading than 17:30, so a regression to device-zone formatting fails
  // those cases (the Los Angeles case cannot tell the two zones apart and only guards the wording).
  const task = makeTask({ title: 'Write report', dueDate: DUE, dueTime: '17:30', startTime: '2026-10-20T09:30:00.000Z' });

  it.each(['Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati', 'UTC'])('preference %s, device in Los Angeles', (zone) => {
    inTimeZone('America/Los_Angeles', () => {
      setPreferredTimeZone(zone);
      // 17:30 is the clock reading the user entered, so it reads back as 17:30 in the zone it was entered for;
      // formatting it in the device's zone instead would print a different time. Day-period case and 12h/24h are
      // locale presentation, so the reading is compared as a 24h value.
      const body = getReminderPayload(task, 'start-now').body;
      expect(body).toMatch(/^Start Write report now to stay on track for .+\.$/);
      expect(clockOf(body)).toBe('17:30');
    });
  });

  it('a date-only task still gets the generic message', () => {
    setPreferredTimeZone('Asia/Kolkata');
    expect(getReminderPayload(makeTask({ title: 'Plan', dueDate: DUE }), 'start-now').body).toBe('Start Plan now to stay on track.');
  });
});
