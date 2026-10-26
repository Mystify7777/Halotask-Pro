import { afterEach, describe, expect, it } from 'vitest';
import { clockOf, namesDay, namesSomeDay } from '../test/localeText';
import { inTimeZone, makeTask, TIME_ZONES } from '../test/taskFactory';
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
  startInputToIso,
} from './deadline';
import { getEffectiveTimeZone, setPreferredTimeZone } from './timeZone';

// Labels are read through test/localeText.ts: the app formats with the runtime's default locale, so "5:30 PM" vs
// "5:30 pm" vs "17:30" and "Oct 20" vs "20 Oct" are presentation. The VALUES (24h clock reading, day, month) are
// asserted exactly; the instants, states and days below are asserted exactly and never through a string.

// Issue #41 — the documented time model, tested through the PREFERRED zone (not the machine's) in UTC, Asia/Kolkata,
// America/Los_Angeles, a daylight-saving transition, and the two extreme offsets:
//   startTime  an instant: it never moves when the zone changes, only how it is displayed.
//   dueDate    a calendar day (the UTC date of the stored value): never rewritten by a zone change.
//   dueTime    a wall-clock "HH:mm" on that day: the zone turns the pair into an instant, so the instant moves.
//   date-only  no dueTime: never an exact deadline, judged by day only.

afterEach(() => setPreferredTimeZone(null));

const DUE = '2026-10-20T00:00:00.000Z'; // what the server stores for a due date of 2026-10-20
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const NOW = (value: string) => new Date(value);

describe('the same task in different preferred zones, whatever the machine\'s zone', () => {
  it.each(TIME_ZONES)('deadline instant, state and day are the zone\'s own when the preference is %s (machine in LA)', (zone) => {
    inTimeZone('America/Los_Angeles', () => {
      const timed = { dueDate: DUE, dueTime: '17:30' };
      const deadline = getExactDeadline(timed, zone)!;

      // Judged against the preferred zone: the deadline instant reads back as 17:30 on the 20th in THAT zone.
      const label = formatDueLabel(timed, new Date(deadline - 3_600_000), zone);
      expect(label).toMatch(/^Due today, /);
      expect(clockOf(label)).toBe('17:30'); // the clock reading in the PREFERRED zone, whatever the machine's
      expect(isPastDeadline(timed, new Date(deadline - 1), zone)).toBe(false);
      expect(isPastDeadline(timed, new Date(deadline), zone)).toBe(true);
      expect(getDueState(timed, new Date(deadline - 1), zone)).toBe('today');
      expect(getDueState(timed, new Date(deadline), zone)).toBe('overdue');
    });
  });

  it.each([
    ['UTC', '2026-10-20T17:30:00.000Z'],
    ['Asia/Kolkata', '2026-10-20T12:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-21T00:30:00.000Z'],
    ['Pacific/Kiritimati', '2026-10-20T03:30:00.000Z'],
    ['Pacific/Pago_Pago', '2026-10-21T04:30:00.000Z'],
  ])('the default zone is the saved preference: %s', (zone, expected) => {
    for (const machine of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      inTimeZone(machine, () => {
        setPreferredTimeZone(zone);
        expect(getEffectiveTimeZone()).toBe(zone);
        expect(iso(getExactDeadline({ dueDate: DUE, dueTime: '17:30' }))).toBe(expected);
      });
    }
  });
});

describe('changing the zone with existing tasks', () => {
  const task = makeTask({ dueDate: DUE, dueTime: '17:30', startTime: '2026-10-20T09:30:00.000Z' });
  const frozen = JSON.stringify(task);

  it('startTime is the same instant in every zone; only its display moves', () => {
    const instants = new Set<number | null>();
    for (const zone of TIME_ZONES) {
      instants.add(getStartInstant(task.startTime));
      void zone;
    }
    expect([...instants]).toEqual([Date.parse('2026-10-20T09:30:00.000Z')]);

    expect(isoToStartInput(task.startTime, 'UTC')).toBe('2026-10-20T09:30');
    expect(isoToStartInput(task.startTime, 'Asia/Kolkata')).toBe('2026-10-20T15:00');
    expect(isoToStartInput(task.startTime, 'America/Los_Angeles')).toBe('2026-10-20T02:30');
    expect(isoToStartInput(task.startTime, 'Pacific/Kiritimati')).toBe('2026-10-20T23:30');
    expect(isoToStartInput(task.startTime, 'Pacific/Pago_Pago')).toBe('2026-10-19T22:30'); // the previous calendar day

    // and each of those readings converts back to the same instant: nothing is lost or shifted
    for (const zone of TIME_ZONES) {
      expect(startInputToIso(isoToStartInput(task.startTime, zone), zone)).toBe(task.startTime);
    }
  });

  it('dueDate and dueTime are the same calendar day and clock in every zone; the deadline instant moves with the zone', () => {
    const seen = new Map<string, string | null>();
    for (const zone of TIME_ZONES) {
      expect(dueDayKey(task.dueDate)).toBe('2026-10-20');
      expect(task.dueTime).toBe('17:30');
      seen.set(zone, iso(getExactDeadline(task, zone)));
    }
    // Kolkata is 5h30 east of UTC, Los Angeles (PDT) 7h west: the two deadline instants differ by exactly 12h30.
    const gap = Date.parse(seen.get('America/Los_Angeles')!) - Date.parse(seen.get('Asia/Kolkata')!);
    expect(gap).toBe(12.5 * 3_600_000);
    expect(new Set(seen.values()).size).toBe(TIME_ZONES.length);
  });

  it('a zone change rewrites nothing: the stored task is byte-for-byte the same', () => {
    for (const zone of TIME_ZONES) {
      setPreferredTimeZone(zone);
      getExactDeadline(task);
      formatDueLabel(task);
      formatStartLabel(task.startTime);
      getDueState(task);
    }
    expect(JSON.stringify(task)).toBe(frozen);
  });

  it('start labels show the same instant as different clock readings', () => {
    const kolkata = formatStartLabel(task.startTime, 'Asia/Kolkata');
    const la = formatStartLabel(task.startTime, 'America/Los_Angeles');
    const pago = formatStartLabel(task.startTime, 'Pacific/Pago_Pago');

    for (const label of [kolkata, la, pago]) expect(label).toMatch(/^Starts /);
    expect([clockOf(kolkata), clockOf(la), clockOf(pago)]).toEqual(['15:00', '02:30', '22:30']);
    expect(namesDay(kolkata, 10, 20)).toBe(true);
    expect(namesDay(la, 10, 20)).toBe(true);
    expect(namesDay(pago, 10, 19)).toBe(true); // the previous calendar day there
  });
});

describe('startInputToIso reads the entered time in the given zone, never the machine\'s', () => {
  it.each([
    ['UTC', '2026-10-20T09:30:00.000Z'],
    ['Asia/Kolkata', '2026-10-20T04:00:00.000Z'],
    ['America/Los_Angeles', '2026-10-20T16:30:00.000Z'],
    ['Pacific/Kiritimati', '2026-10-19T19:30:00.000Z'],
    ['Pacific/Pago_Pago', '2026-10-20T20:30:00.000Z'],
  ])('09:30 on 2026-10-20 in %s', (zone, expected) => {
    for (const machine of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
      inTimeZone(machine, () => expect(startInputToIso('2026-10-20T09:30', zone)).toBe(expected));
    }
  });

  it('follows the saved preference when no zone is passed', () => {
    inTimeZone('America/Los_Angeles', () => {
      setPreferredTimeZone('Asia/Kolkata');
      expect(startInputToIso('2026-10-20T09:30')).toBe('2026-10-20T04:00:00.000Z');
      expect(isoToStartInput('2026-10-20T04:00:00.000Z')).toBe('2026-10-20T09:30');
    });
  });

  it.each(['2026-02-30T09:30', '2026-13-01T09:30', '2026-10-20T24:00', '2026-10-20', '', 'tomorrow'])('rejects %j (never rolled over)', (input) => {
    expect(startInputToIso(input, 'UTC')).toBeNull();
  });

  it('a start time in the spring-forward gap resolves one hour later and reads back as that later time', () => {
    const stored = startInputToIso('2026-03-08T02:30', 'America/Los_Angeles');
    expect(stored).toBe('2026-03-08T10:30:00.000Z');
    expect(isoToStartInput(stored, 'America/Los_Angeles')).toBe('2026-03-08T03:30');
  });

  it('a start time in the repeated fall-back hour is the first occurrence', () => {
    expect(startInputToIso('2026-11-01T01:30', 'America/Los_Angeles')).toBe('2026-11-01T08:30:00.000Z');
  });
});

describe('overdue / today / upcoming at the boundary, by zone', () => {
  // 17:30 on the 20th is 12:00Z in Kolkata and 00:30Z on the 21st in Los Angeles.
  const timed = { dueDate: DUE, dueTime: '17:30' };

  it('Kolkata: today until 12:00Z, overdue from that exact second', () => {
    expect(getDueState(timed, NOW('2026-10-20T11:59:59Z'), 'Asia/Kolkata')).toBe('today');
    expect(getDueState(timed, NOW('2026-10-20T12:00:00Z'), 'Asia/Kolkata')).toBe('overdue');
  });

  it('Los Angeles: still today at 12:00Z, overdue from 00:30Z on the next UTC day', () => {
    expect(getDueState(timed, NOW('2026-10-20T12:00:00Z'), 'America/Los_Angeles')).toBe('today');
    expect(getDueState(timed, NOW('2026-10-21T00:29:59Z'), 'America/Los_Angeles')).toBe('today');
    expect(getDueState(timed, NOW('2026-10-21T00:30:00Z'), 'America/Los_Angeles')).toBe('overdue');
  });

  it('a timed task earlier in the day than now is overdue even though its day is still today', () => {
    expect(getDueState({ dueDate: DUE, dueTime: '08:00' }, NOW('2026-10-20T12:00:00Z'), 'UTC')).toBe('overdue');
  });

  describe('a date-only task is judged by its day in the zone: the 20th is overdue once the zone reaches the 21st', () => {
    const dateOnly = { dueDate: DUE };
    // 2026-10-20 20:00Z: the 21st at +05:30 and +14:00, still the 20th at UTC, -07:00 and -11:00.
    it.each([
      ['UTC', 'today'],
      ['Asia/Kolkata', 'overdue'],
      ['America/Los_Angeles', 'today'],
      ['Pacific/Kiritimati', 'overdue'],
      ['Pacific/Pago_Pago', 'today'],
    ])('%s -> %s', (zone, state) => {
      expect(getDueState(dateOnly, NOW('2026-10-20T20:00:00Z'), zone)).toBe(state);
    });

    it('"later" turns into "today" when the zone reaches the day, east before west', () => {
      const now = NOW('2026-10-19T20:00:00Z'); // the 20th at +14:00, the 19th at -11:00 and in UTC
      expect(getDueState(dateOnly, now, 'Pacific/Kiritimati')).toBe('today');
      expect(getDueState(dateOnly, now, 'Pacific/Pago_Pago')).toBe('later');
      expect(getDueState(dateOnly, now, 'UTC')).toBe('later');
    });

    it('is never an exact deadline and carries no time in its label, in any zone', () => {
      for (const zone of TIME_ZONES) {
        expect(getExactDeadline(dateOnly, zone)).toBeNull();
        const label = formatDueLabel(dateOnly, NOW('2026-10-20T12:00:00Z'), zone);
        expect(label).toMatch(/^Due /);
        expect(clockOf(label)).toBeNull(); // no clock reading: a date-only task never acquires a time
        expect(label === 'Due today' || label === 'Due tomorrow' || namesSomeDay(label)).toBe(true);
      }
    });
  });

  it('labels use the zone\'s today and tomorrow', () => {
    const now = NOW('2026-10-20T20:00:00Z');
    expect(formatDueLabel({ dueDate: DUE }, now, 'America/Los_Angeles')).toBe('Due today');
    const yesterdayThere = formatDueLabel({ dueDate: DUE }, now, 'Asia/Kolkata'); // already yesterday there
    expect(yesterdayThere).toMatch(/^Due /);
    expect(namesDay(yesterdayThere, 10, 20)).toBe(true);
    expect(clockOf(yesterdayThere)).toBeNull();
    expect(formatDueLabel({ dueDate: '2026-10-21T00:00:00.000Z' }, now, 'Asia/Kolkata')).toBe('Due today');
    expect(formatDueLabel({ dueDate: '2026-10-21T00:00:00.000Z' }, now, 'America/Los_Angeles')).toBe('Due tomorrow');
  });

  it('the day text is the stored day in every zone and machine zone (never a day early west of UTC)', () => {
    for (const machine of ['UTC', 'America/Los_Angeles', 'Pacific/Pago_Pago'] as const) {
      inTimeZone(machine, () => {
        for (const zone of TIME_ZONES) {
          const label = formatDueLabel({ dueDate: '2026-12-25T00:00:00.000Z' }, NOW('2026-10-01T12:00:00Z'), zone);
          expect(label).toMatch(/^Due /);
          expect(namesDay(label, 12, 25)).toBe(true); // 25 December, never the 24th
        }
      });
    }
  });
});

describe('daylight saving in due times', () => {
  const LA = 'America/Los_Angeles';

  it('spring forward: a due time of 02:30 on 2026-03-08 is 03:30 PDT, still that day', () => {
    const task = { dueDate: '2026-03-08T00:00:00.000Z', dueTime: '02:30' };
    expect(iso(getExactDeadline(task, LA))).toBe('2026-03-08T10:30:00.000Z');
    const label = formatDueLabel(task, NOW('2026-03-08T12:00:00Z'), LA);
    expect(label).toMatch(/^Due today, /);
    expect(clockOf(label)).toBe('03:30'); // the resolved (later) reading, not the 02:30 that does not exist
    expect(isPastDeadline(task, NOW('2026-03-08T10:29:59Z'), LA)).toBe(false);
    expect(isPastDeadline(task, NOW('2026-03-08T10:30:00Z'), LA)).toBe(true);
  });

  it('fall back: a due time of 01:30 on 2026-11-01 is the first 01:30 (PDT); overdue from 08:30Z, not 09:30Z', () => {
    const task = { dueDate: '2026-11-01T00:00:00.000Z', dueTime: '01:30' };
    expect(iso(getExactDeadline(task, LA))).toBe('2026-11-01T08:30:00.000Z');
    expect(isPastDeadline(task, NOW('2026-11-01T08:29:59Z'), LA)).toBe(false);
    expect(isPastDeadline(task, NOW('2026-11-01T08:30:00Z'), LA)).toBe(true);
  });

  it('the same wall-clock due time is a different instant on either side of a transition', () => {
    const before = getExactDeadline({ dueDate: '2026-11-01T00:00:00.000Z', dueTime: '12:00' }, LA)!; // PST after fall-back
    const earlier = getExactDeadline({ dueDate: '2026-10-31T00:00:00.000Z', dueTime: '12:00' }, LA)!; // PDT
    expect(before - earlier).toBe(25 * 3_600_000);
  });

  it('a zone with no daylight saving never changes offset (Kolkata)', () => {
    const summer = getExactDeadline({ dueDate: '2026-07-01T00:00:00.000Z', dueTime: '12:00' }, 'Asia/Kolkata')!;
    const winter = getExactDeadline({ dueDate: '2026-12-01T00:00:00.000Z', dueTime: '12:00' }, 'Asia/Kolkata')!;
    expect(iso(summer)).toBe('2026-07-01T06:30:00.000Z');
    expect(iso(winter)).toBe('2026-12-01T06:30:00.000Z');
  });
});

describe('ordering does not depend on the zone', () => {
  it('compareDeadlines orders by day then clock reading, the same under every preference', () => {
    const a = { dueDate: DUE, dueTime: '09:00' };
    const b = { dueDate: DUE, dueTime: '17:30' };
    const c = { dueDate: DUE };
    for (const zone of TIME_ZONES) {
      setPreferredTimeZone(zone);
      expect(compareDeadlines(a, b)).toBeLessThan(0);
      expect(compareDeadlines(b, c)).toBeLessThan(0); // date-only after the timed tasks of its day
    }
  });
});
