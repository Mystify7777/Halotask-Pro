import { afterEach, describe, expect, it } from 'vitest';
import { inTimeZone, TIME_ZONES } from '../test/taskFactory';
import {
  dateKeyInZone,
  dateKeyOffsetInZone,
  describeTimeZone,
  formatZoneOffset,
  getDeviceTimeZone,
  getEffectiveTimeZone,
  getPreferredTimeZone,
  isUsableTimeZone,
  listTimeZones,
  setPreferredTimeZone,
  timeOfDayInZone,
  wallClockAt,
  zonedWallClockToInstant,
} from './timeZone';

// Issue #41 — the zone core. Every conversion takes its zone EXPLICITLY, so none of these results may depend on the
// machine's own zone: the conversion tests run under several process zones and must not change.

afterEach(() => setPreferredTimeZone(null));

const iso = (ms: number) => new Date(ms).toISOString();
const at = (tz: string, y: number, mo: number, d: number, h: number, mi = 0) => iso(zonedWallClockToInstant(y, mo, d, h, mi, tz));

describe('isUsableTimeZone', () => {
  it.each(['UTC', 'Asia/Kolkata', 'Asia/Calcutta', 'America/Los_Angeles', 'Pacific/Kiritimati'])('accepts %s', (zone) => {
    expect(isUsableTimeZone(zone)).toBe(true);
  });

  // Intl itself accepts "+05:30"; a fixed offset is not an IANA zone and has no daylight-saving rules.
  it.each(['+05:30', '-08:00', 'UTC+05:30', 'Nowhere/Land', '', ' UTC', 5, null, undefined, {}])('rejects %j', (zone) => {
    expect(isUsableTimeZone(zone)).toBe(false);
  });
});

describe('effective zone: saved preference, else the device, else UTC', () => {
  it('uses the saved preference when there is one', () => {
    setPreferredTimeZone('Asia/Kolkata');
    expect(getPreferredTimeZone()).toBe('Asia/Kolkata');
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
  });

  // The runtime may name India's zone with either spelling (older ICU: Asia/Calcutta), so both are accepted.
  it.each([
    ['America/Los_Angeles', ['America/Los_Angeles']],
    ['Asia/Kolkata', ['Asia/Kolkata', 'Asia/Calcutta']],
  ])('falls back to the device zone (%s) without saving it', (processZone, accepted) => {
    inTimeZone(processZone, () => {
      setPreferredTimeZone(null);
      expect(getPreferredTimeZone()).toBeNull(); // the fallback is NOT recorded as a preference
      expect(accepted).toContain(getDeviceTimeZone());
      expect(getEffectiveTimeZone()).toBe(getDeviceTimeZone());
    });
  });

  it('a saved preference wins over the device zone', () => {
    inTimeZone('America/Los_Angeles', () => {
      setPreferredTimeZone('Asia/Kolkata');
      expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
    });
  });

  it.each(['+05:30', 'Nowhere/Land', '', undefined])('treats an unusable preference (%j) as no preference', (value) => {
    setPreferredTimeZone('Asia/Kolkata');
    setPreferredTimeZone(value);
    expect(getPreferredTimeZone()).toBeNull();
  });

  it('changing the preference changes the effective zone immediately, and clearing returns to the fallback', () => {
    inTimeZone('America/Los_Angeles', () => {
      setPreferredTimeZone('Asia/Kolkata');
      setPreferredTimeZone('Europe/London');
      expect(getEffectiveTimeZone()).toBe('Europe/London');
      setPreferredTimeZone(null);
      expect(getEffectiveTimeZone()).toBe('America/Los_Angeles');
    });
  });
});

describe.each(['UTC', 'Asia/Kolkata', 'America/Los_Angeles'])('wall clock <-> instant, with the machine in %s', (machineZone) => {
  it.each([
    ['UTC', '2026-10-20T17:30:00.000Z'],
    ['Asia/Kolkata', '2026-10-20T12:00:00.000Z'], // +05:30
    ['America/Los_Angeles', '2026-10-21T00:30:00.000Z'], // PDT -07:00
    ['America/New_York', '2026-10-20T21:30:00.000Z'], // EDT -04:00
    ['Pacific/Kiritimati', '2026-10-20T03:30:00.000Z'], // +14:00, the furthest east
    ['Pacific/Pago_Pago', '2026-10-21T04:30:00.000Z'], // -11:00, among the furthest west
    ['Australia/Lord_Howe', '2026-10-20T06:30:00.000Z'], // +11:00 daylight time, a 30-minute DST shift
  ])('17:30 on 2026-10-20 in %s', (zone, expected) => {
    inTimeZone(machineZone, () => expect(at(zone, 2026, 10, 20, 17, 30)).toBe(expected));
  });

  it('round-trips: the instant reads back as the same date and clock in its zone', () => {
    inTimeZone(machineZone, () => {
      for (const zone of TIME_ZONES) {
        const instant = zonedWallClockToInstant(2026, 10, 20, 17, 30, zone);
        expect(dateKeyInZone(instant, zone)).toBe('2026-10-20');
        expect(timeOfDayInZone(instant, zone)).toBe('17:30');
      }
    });
  });

  describe('spring forward: a wall-clock time that does not exist resolves one hour later', () => {
    it('Los Angeles, 2026-03-08: 02:30 does not exist, it is 03:30 PDT (10:30Z)', () => {
      inTimeZone(machineZone, () => {
        const instant = zonedWallClockToInstant(2026, 3, 8, 2, 30, 'America/Los_Angeles');
        expect(iso(instant)).toBe('2026-03-08T10:30:00.000Z');
        expect(timeOfDayInZone(instant, 'America/Los_Angeles')).toBe('03:30');
        expect(dateKeyInZone(instant, 'America/Los_Angeles')).toBe('2026-03-08'); // same day, not shifted
      });
    });

    it('the times either side of the gap are exact: 01:59 PST and 03:00 PDT', () => {
      inTimeZone(machineZone, () => {
        expect(at('America/Los_Angeles', 2026, 3, 8, 1, 59)).toBe('2026-03-08T09:59:00.000Z');
        expect(at('America/Los_Angeles', 2026, 3, 8, 3, 0)).toBe('2026-03-08T10:00:00.000Z');
        expect(at('America/Los_Angeles', 2026, 3, 8, 2, 0)).toBe('2026-03-08T10:00:00.000Z'); // the first skipped minute
      });
    });

    it('London, 2026-03-29: 01:30 does not exist, it is 02:30 BST (01:30Z)', () => {
      inTimeZone(machineZone, () => expect(at('Europe/London', 2026, 3, 29, 1, 30)).toBe('2026-03-29T01:30:00.000Z'));
    });

    it('Lord Howe, 2026-10-04 (a 30-minute shift): 02:15 does not exist, it is 02:45 daylight time', () => {
      inTimeZone(machineZone, () => {
        const instant = zonedWallClockToInstant(2026, 10, 4, 2, 15, 'Australia/Lord_Howe');
        expect(timeOfDayInZone(instant, 'Australia/Lord_Howe')).toBe('02:45');
        expect(dateKeyInZone(instant, 'Australia/Lord_Howe')).toBe('2026-10-04');
      });
    });
  });

  describe('fall back: a wall-clock time that occurs twice resolves to its first occurrence', () => {
    it('Los Angeles, 2026-11-01: 01:30 happens twice, the first is 01:30 PDT (08:30Z), not 01:30 PST (09:30Z)', () => {
      inTimeZone(machineZone, () => expect(at('America/Los_Angeles', 2026, 11, 1, 1, 30)).toBe('2026-11-01T08:30:00.000Z'));
    });

    it('the times either side of the repeated hour are unambiguous', () => {
      inTimeZone(machineZone, () => {
        expect(at('America/Los_Angeles', 2026, 11, 1, 0, 59)).toBe('2026-11-01T07:59:00.000Z'); // PDT
        expect(at('America/Los_Angeles', 2026, 11, 1, 2, 0)).toBe('2026-11-01T10:00:00.000Z'); // PST
      });
    });

    it('Sydney (southern hemisphere), 2026-04-05: 02:30 happens twice, the first is on daylight time (+11)', () => {
      inTimeZone(machineZone, () => expect(at('Australia/Sydney', 2026, 4, 5, 2, 30)).toBe('2026-04-04T15:30:00.000Z'));
    });

    it('London, 2026-10-25: 01:30 happens twice, the first is 01:30 BST (00:30Z)', () => {
      inTimeZone(machineZone, () => expect(at('Europe/London', 2026, 10, 25, 1, 30)).toBe('2026-10-25T00:30:00.000Z'));
    });
  });

  it.each([
    ['month 13', [2026, 13, 1, 9, 0]],
    ['February 30', [2026, 2, 30, 9, 0]],
    ['February 29 in a common year', [2026, 2, 29, 9, 0]],
    ['hour 24', [2026, 10, 20, 24, 0]],
    ['minute 60', [2026, 10, 20, 9, 60]],
  ])('an impossible date or time (%s) is NaN, never rolled into another day', (_label, [y, mo, d, h, mi]) => {
    inTimeZone(machineZone, () => expect(zonedWallClockToInstant(y, mo, d, h, mi, 'UTC')).toBeNaN());
  });

  it('a real leap day is accepted', () => {
    inTimeZone(machineZone, () => expect(at('UTC', 2028, 2, 29, 9, 0)).toBe('2028-02-29T09:00:00.000Z'));
  });
});

describe('day boundaries in positive and negative offsets', () => {
  // 2026-10-20 20:00Z is already the 21st in the east and still the 20th in the west.
  const instant = Date.parse('2026-10-20T20:00:00.000Z');

  it.each([
    ['UTC', '2026-10-20', '20:00'],
    ['Asia/Kolkata', '2026-10-21', '01:30'],
    ['America/Los_Angeles', '2026-10-20', '13:00'],
    ['Pacific/Kiritimati', '2026-10-21', '10:00'],
    ['Pacific/Pago_Pago', '2026-10-20', '09:00'],
  ])('%s: day %s, clock %s', (zone, day, clock) => {
    expect(dateKeyInZone(instant, zone)).toBe(day);
    expect(timeOfDayInZone(instant, zone)).toBe(clock);
  });

  it('midnight is hour 0, never "24"', () => {
    const midnight = zonedWallClockToInstant(2026, 10, 21, 0, 0, 'Asia/Kolkata');
    expect(wallClockAt(midnight, 'Asia/Kolkata')).toMatchObject({ day: 21, hour: 0, minute: 0 });
  });

  it('dateKeyOffsetInZone is calendar arithmetic across month, year and leap-day boundaries', () => {
    const newYearsEve = Date.parse('2026-12-31T20:00:00.000Z');
    expect(dateKeyOffsetInZone(1, newYearsEve, 'UTC')).toBe('2027-01-01');
    expect(dateKeyOffsetInZone(1, newYearsEve, 'Asia/Kolkata')).toBe('2027-01-02'); // already 1 Jan there
    expect(dateKeyOffsetInZone(-1, newYearsEve, 'Pacific/Pago_Pago')).toBe('2026-12-30');
    expect(dateKeyOffsetInZone(1, Date.parse('2028-02-28T12:00:00Z'), 'UTC')).toBe('2028-02-29');
  });

  it('a calendar day that is 23 or 25 hours long still advances by exactly one day', () => {
    const beforeSpringForward = Date.parse('2026-03-07T20:00:00.000Z'); // 12:00 on the 7th in Los Angeles
    expect(dateKeyOffsetInZone(1, beforeSpringForward, 'America/Los_Angeles')).toBe('2026-03-08');
    expect(dateKeyOffsetInZone(2, beforeSpringForward, 'America/Los_Angeles')).toBe('2026-03-09');
  });
});

describe('choosing a zone', () => {
  it('lists the runtime\'s own zones (no list of ours), all usable', () => {
    const zones = listTimeZones();
    expect(zones.some((zone) => zone === 'Asia/Kolkata' || zone === 'Asia/Calcutta')).toBe(true);
    expect(zones).toContain('America/Los_Angeles');
    expect(zones.every(isUsableTimeZone)).toBe(true);
  });

  it('shows a zone with its current offset, for display only', () => {
    expect(formatZoneOffset('Asia/Kolkata', Date.parse('2026-10-20T00:00:00Z'))).toBe('UTC+05:30');
    expect(formatZoneOffset('America/Los_Angeles', Date.parse('2026-07-01T00:00:00Z'))).toBe('UTC-07:00');
    expect(formatZoneOffset('America/Los_Angeles', Date.parse('2026-01-01T00:00:00Z'))).toBe('UTC-08:00');
    expect(formatZoneOffset('UTC')).toBe('UTC');
    expect(describeTimeZone('America/Los_Angeles', Date.parse('2026-01-01T00:00:00Z'))).toBe('America/Los Angeles (UTC-08:00)');
  });
});
