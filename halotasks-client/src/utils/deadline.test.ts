import { afterEach, describe, expect, it, vi } from 'vitest';
import { inTimeZone, TIME_ZONES } from '../test/taskFactory';
import {
  compareDeadlines,
  dueDayKey,
  formatDueLabel,
  formatStartLabel,
  getDueState,
  getExactDeadline,
  getStartInstant,
  isoToStartInput,
  isPastDeadline,
  isValidDueTime,
  startInputToIso,
} from './deadline';

afterEach(() => {
  vi.useRealTimers();
});

/** A local wall-clock moment in the CURRENT timezone. */
const local = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0) => new Date(y, mo - 1, d, h, mi, s);

describe('isValidDueTime', () => {
  it.each(['00:00', '09:05', '23:59'])('accepts %s', (v) => expect(isValidDueTime(v)).toBe(true));
  it.each(['24:00', '9:05', '12:60', '', 'noon', '09:05:00', 905, null, undefined])('rejects %j', (v) => expect(isValidDueTime(v)).toBe(false));
});

describe('dueDayKey: the due DAY is the UTC date of the stored due date, in every timezone', () => {
  it.each(TIME_ZONES)('is unchanged in %s', (tz) => {
    inTimeZone(tz, () => {
      expect(dueDayKey('2026-10-20T00:00:00.000Z')).toBe('2026-10-20'); // what the server returns
      expect(dueDayKey('2026-10-20')).toBe('2026-10-20'); // what an offline-created task still holds locally
      expect(dueDayKey('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
    });
  });

  it.each([undefined, null, '', 'not-a-date'])('is null for %j', (v) => expect(dueDayKey(v)).toBeNull());
});

describe('getExactDeadline: the due day plus the due time, in the viewer\'s zone', () => {
  it.each([
    ['UTC', '2026-10-20T17:30:00.000Z'],
    ['Asia/Kolkata', '2026-10-20T12:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-21T00:30:00.000Z'], // PDT, UTC-7
    ['America/New_York', '2026-10-20T21:30:00.000Z'], // EDT, UTC-4
    ['Pacific/Kiritimati', '2026-10-20T03:30:00.000Z'], // UTC+14
    ['Pacific/Pago_Pago', '2026-10-21T04:30:00.000Z'], // UTC-11
  ])('is 17:30 local on 2026-10-20 in %s', (tz, iso) => {
    inTimeZone(tz, () => {
      expect(new Date(getExactDeadline({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' })!).toISOString()).toBe(iso);
    });
  });

  it('is null for a date-only task: it is never turned into a midnight deadline', () => {
    for (const tz of TIME_ZONES) inTimeZone(tz, () => expect(getExactDeadline({ dueDate: '2026-10-20T00:00:00.000Z' })).toBeNull());
  });

  it.each([
    ['a due time without a due date', { dueTime: '09:00' }],
    ['an invalid due time', { dueDate: '2026-10-20', dueTime: '25:00' }],
    ['an unparseable due date', { dueDate: 'nope', dueTime: '09:00' }],
  ])('is null for %s', (_label, fields) => expect(getExactDeadline(fields)).toBeNull());

  describe('daylight saving', () => {
    it('a wall-clock time that does not exist (spring forward, 02:30 on 2026-03-08 in New York) resolves one hour later', () => {
      inTimeZone('America/New_York', () => {
        const exact = new Date(getExactDeadline({ dueDate: '2026-03-08', dueTime: '02:30' })!);
        expect(exact.toISOString()).toBe('2026-03-08T07:30:00.000Z'); // 03:30 EDT
        expect([exact.getHours(), exact.getMinutes()]).toEqual([3, 30]);
      });
    });

    it('an ambiguous time (fall back, 01:30 on 2026-11-01 in New York) resolves to its first occurrence', () => {
      inTimeZone('America/New_York', () => {
        expect(new Date(getExactDeadline({ dueDate: '2026-11-01', dueTime: '01:30' })!).toISOString()).toBe('2026-11-01T05:30:00.000Z'); // EDT
      });
    });

    it('a time on either side of a transition keeps its wall-clock value', () => {
      inTimeZone('America/New_York', () => {
        for (const [day, expectedUtcHour] of [['2026-03-07', 14], ['2026-03-09', 13]] as const) {
          // 09:00 local is 14:00Z on the EST day before spring forward and 13:00Z on the EDT day after.
          expect(new Date(getExactDeadline({ dueDate: day, dueTime: '09:00' })!).getUTCHours()).toBe(expectedUtcHour);
        }
      });
    });
  });
});

describe('getStartInstant', () => {
  it('reads an ISO instant', () => expect(getStartInstant('2026-10-20T09:30:00.000Z')).toBe(Date.UTC(2026, 9, 20, 9, 30)));
  it.each([undefined, null, '', 'soon'])('is null for %j', (v) => expect(getStartInstant(v)).toBeNull());
});

describe('compareDeadlines', () => {
  const dated = (dueDate: string, dueTime?: string) => ({ dueDate: `${dueDate}T00:00:00.000Z`, dueTime });
  const none = {};
  const sort = (items: Array<Parameters<typeof compareDeadlines>[0]>) => [...items].sort(compareDeadlines);

  it('orders by due day, then by time of day', () => {
    expect(sort([dated('2026-10-21', '08:00'), dated('2026-10-20', '17:00'), dated('2026-10-20', '09:00')])).toEqual([
      dated('2026-10-20', '09:00'),
      dated('2026-10-20', '17:00'),
      dated('2026-10-21', '08:00'),
    ]);
  });

  it('puts a date-only task after the timed tasks of its own day (it is due by the end of the day), never at midnight', () => {
    expect(sort([dated('2026-10-20'), dated('2026-10-20', '23:59'), dated('2026-10-20', '00:00')])).toEqual([
      dated('2026-10-20', '00:00'),
      dated('2026-10-20', '23:59'),
      dated('2026-10-20'),
    ]);
  });

  it('keeps date-only tasks in their established by-day order, with ties unordered (stable)', () => {
    expect(compareDeadlines(dated('2026-10-20'), dated('2026-10-20'))).toBe(0);
    expect(sort([dated('2026-10-22'), dated('2026-10-20'), dated('2026-10-21')]).map((t) => t.dueDate?.slice(0, 10))).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
    ]);
  });

  it('puts tasks without a due date last', () => {
    expect(sort([none, dated('2026-10-20', '09:00'), none])).toEqual([dated('2026-10-20', '09:00'), none, none]);
    expect(compareDeadlines(none, none)).toBe(0);
  });

  it('is the same in every timezone', () => {
    const items = [dated('2026-10-20', '17:00'), dated('2026-10-20'), dated('2026-10-19', '23:00')];
    const expected = sort(items);
    for (const tz of TIME_ZONES) inTimeZone(tz, () => expect(sort(items)).toEqual(expected));
  });
});

describe('deadline boundaries (overdue / today / later)', () => {
  const dateOnly = { dueDate: '2026-10-20T00:00:00.000Z' };
  const timed = { dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' };

  it.each(TIME_ZONES)('a date-only task is due today for the whole of its day, and overdue from the next local midnight (%s)', (tz) => {
    inTimeZone(tz, () => {
      expect(getDueState(dateOnly, local(2026, 10, 20, 0, 0, 0))).toBe('today');
      expect(getDueState(dateOnly, local(2026, 10, 20, 12, 0, 0))).toBe('today');
      expect(getDueState(dateOnly, local(2026, 10, 20, 23, 59, 59))).toBe('today');
      expect(getDueState(dateOnly, local(2026, 10, 21, 0, 0, 0))).toBe('overdue');
      expect(getDueState(dateOnly, local(2026, 10, 19, 23, 59, 59))).toBe('later');
      expect(isPastDeadline(dateOnly, local(2026, 10, 20, 23, 59, 59))).toBe(false);
    });
  });

  it.each(TIME_ZONES)('a timed task is overdue from its exact moment, not from midnight (%s)', (tz) => {
    inTimeZone(tz, () => {
      expect(getDueState(timed, local(2026, 10, 20, 0, 0, 0))).toBe('today');
      expect(getDueState(timed, local(2026, 10, 20, 17, 29, 59))).toBe('today');
      expect(getDueState(timed, local(2026, 10, 20, 17, 30, 0))).toBe('overdue');
      expect(getDueState(timed, local(2026, 10, 21, 0, 0, 0))).toBe('overdue');
      expect(getDueState(timed, local(2026, 10, 19, 23, 59, 59))).toBe('later');
    });
  });

  it('a task with no due date has no state', () => {
    expect(getDueState({}, new Date())).toBe('none');
    expect(getDueState({ dueDate: 'garbage' }, new Date())).toBe('none');
  });

  it('west of UTC a date-only task is due on the day that was picked, not the day before', () => {
    // The UTC-midnight instant of 2026-10-20 is 17:00 on the 19th in Los Angeles; reading it locally made the
    // task "overdue" on its own due day. The due day is the calendar day that was picked.
    inTimeZone('America/Los_Angeles', () => {
      expect(getDueState(dateOnly, local(2026, 10, 20, 9, 0))).toBe('today');
      expect(getDueState(dateOnly, local(2026, 10, 19, 20, 0))).toBe('later');
    });
  });

  it('crossing a daylight-saving change does not move a day boundary', () => {
    inTimeZone('America/New_York', () => {
      const task = { dueDate: '2026-11-01T00:00:00.000Z' }; // the 25-hour fall-back day
      expect(getDueState(task, local(2026, 11, 1, 0, 30))).toBe('today');
      expect(getDueState(task, local(2026, 11, 1, 23, 30))).toBe('today');
      expect(getDueState(task, local(2026, 11, 2, 0, 0))).toBe('overdue');
    });
  });
});

describe('labels', () => {
  const now = () => local(2026, 10, 20, 8, 0);

  it.each(TIME_ZONES)('says today / tomorrow / the date for a date-only task, in %s', (tz) => {
    inTimeZone(tz, () => {
      expect(formatDueLabel({ dueDate: '2026-10-20T00:00:00.000Z' }, now())).toBe('Due today');
      expect(formatDueLabel({ dueDate: '2026-10-21T00:00:00.000Z' }, now())).toBe('Due tomorrow');
      expect(formatDueLabel({ dueDate: '2026-10-25T00:00:00.000Z' }, now())).toMatch(/^Due .*25/);
      expect(formatDueLabel({}, now())).toBe('');
    });
  });

  it('adds the time for a timed task, and only then', () => {
    expect(formatDueLabel({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' }, now())).toMatch(/^Due today, (5:30|17:30)/);
    expect(formatDueLabel({ dueDate: '2026-10-20T00:00:00.000Z' }, now())).toBe('Due today');
  });

  it('describes a start time, or nothing for an unusable one', () => {
    expect(formatStartLabel('2026-10-20T09:30:00.000Z')).toMatch(/^Starts /);
    expect(formatStartLabel(undefined)).toBe('');
    expect(formatStartLabel('soon')).toBe('');
  });
});

describe('start input <-> stored instant', () => {
  it.each(TIME_ZONES)('a local entry is stored as the instant it names and shown back unchanged, in %s', (tz) => {
    inTimeZone(tz, () => {
      const iso = startInputToIso('2026-10-20T09:30')!;
      expect(new Date(iso).getHours()).toBe(9);
      expect(new Date(iso).getMinutes()).toBe(30);
      expect(iso).toMatch(/Z$/);
      expect(isoToStartInput(iso)).toBe('2026-10-20T09:30');
    });
  });

  it('the same local entry is a different instant in a different zone (it is the user\'s wall clock)', () => {
    const kolkata = inTimeZone('Asia/Kolkata', () => startInputToIso('2026-10-20T09:30'));
    const la = inTimeZone('America/Los_Angeles', () => startInputToIso('2026-10-20T09:30'));
    expect(kolkata).toBe('2026-10-20T04:00:00.000Z');
    expect(la).toBe('2026-10-20T16:30:00.000Z');
  });

  it('a stored instant is shown in the viewer\'s own zone', () => {
    expect(inTimeZone('Asia/Kolkata', () => isoToStartInput('2026-10-20T04:00:00.000Z'))).toBe('2026-10-20T09:30');
    expect(inTimeZone('America/Los_Angeles', () => isoToStartInput('2026-10-20T16:30:00.000Z'))).toBe('2026-10-20T09:30');
  });

  it('a local time that does not exist (spring forward) is stored as the real instant JavaScript resolves it to', () => {
    inTimeZone('America/New_York', () => {
      const iso = startInputToIso('2026-03-08T02:30')!;
      expect(iso).toBe('2026-03-08T07:30:00.000Z');
      expect(isoToStartInput(iso)).toBe('2026-03-08T03:30');
    });
  });

  it.each(['', '2026-10-20', '2026-10-20T09:30:00', '2026-10-20 09:30', 'soon', '2026-02-30T09:30'])('rejects %j', (value) => {
    expect(startInputToIso(value)).toBeNull();
  });

  it('shows nothing for an absent or unusable stored value', () => {
    expect(isoToStartInput(undefined)).toBe('');
    expect(isoToStartInput('soon')).toBe('');
  });
});
