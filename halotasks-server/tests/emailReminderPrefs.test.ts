import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EMAIL_PREFS,
  effectiveEmailTimeZone,
  isInQuietHours,
  parseEmailPrefsUpdate,
  resolveEmailPrefs,
} from '../src/utils/emailReminderPrefs';

// Issue #29, section S2 — the pure preference rules: defaults, the strict update parser, the effective zone and quiet hours.

describe('resolveEmailPrefs', () => {
  it('an account with nothing stored has email OFF and every other default', () => {
    expect(resolveEmailPrefs(undefined)).toEqual(DEFAULT_EMAIL_PREFS);
    expect(resolveEmailPrefs({})).toEqual(DEFAULT_EMAIL_PREFS);
    expect(DEFAULT_EMAIL_PREFS.enabled).toBe(false);
    expect(DEFAULT_EMAIL_PREFS.digestEnabled).toBe(false);
    expect(DEFAULT_EMAIL_PREFS.timeZone).toBeNull();
  });

  it('keeps valid stored values and replaces unusable ones with the default, field by field', () => {
    const prefs = resolveEmailPrefs({
      enabled: true,
      dueSoonEnabled: false,
      bufferMinutes: 30,
      quietHoursStart: '23:00',
      quietHoursEnd: '25:00', // unusable
      digestTime: 'noon', // unusable
      timeZone: 'Asia/Kolkata',
      overdueEnabled: 'yes', // wrong type
    });
    expect(prefs).toMatchObject({
      enabled: true,
      dueSoonEnabled: false,
      bufferMinutes: 30,
      quietHoursStart: '23:00',
      quietHoursEnd: DEFAULT_EMAIL_PREFS.quietHoursEnd,
      digestTime: DEFAULT_EMAIL_PREFS.digestTime,
      timeZone: 'Asia/Kolkata',
      overdueEnabled: true,
    });
  });

  it('never throws on junk and ignores a bad time zone', () => {
    for (const junk of [null, 5, 'x', [], { bufferMinutes: 45, timeZone: '+05:30' }]) {
      const prefs = resolveEmailPrefs(junk);
      expect(prefs.bufferMinutes).toBe(60);
      expect(prefs.timeZone).toBeNull();
    }
  });
});

describe('effectiveEmailTimeZone', () => {
  const follow = DEFAULT_EMAIL_PREFS;
  it('follows the account zone while there is no override, and tracks its change', () => {
    expect(effectiveEmailTimeZone(follow, 'Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(effectiveEmailTimeZone(follow, 'America/Los_Angeles')).toBe('America/Los_Angeles');
  });
  it('an explicit override stays fixed when the account zone changes', () => {
    const fixed = { ...follow, timeZone: 'Europe/Berlin' };
    expect(effectiveEmailTimeZone(fixed, 'Asia/Kolkata')).toBe('Europe/Berlin');
    expect(effectiveEmailTimeZone(fixed, 'America/Los_Angeles')).toBe('Europe/Berlin');
  });
  it('falls back to UTC, never to a guess, when neither is set or the account value is unusable', () => {
    expect(effectiveEmailTimeZone(follow, null)).toBe('UTC');
    expect(effectiveEmailTimeZone(follow, undefined)).toBe('UTC');
    expect(effectiveEmailTimeZone(follow, '+05:30')).toBe('UTC');
  });
});

describe('parseEmailPrefsUpdate', () => {
  it('accepts a partial body and addresses only the emailReminders.* paths', () => {
    expect(parseEmailPrefsUpdate({ enabled: true, quietHoursStart: '21:00', bufferMinutes: 15 })).toEqual({
      ok: true,
      set: { 'emailReminders.enabled': true, 'emailReminders.quietHoursStart': '21:00', 'emailReminders.bufferMinutes': 15 },
      unset: [],
    });
  });

  it('timeZone: a valid zone is set, null removes the override', () => {
    expect(parseEmailPrefsUpdate({ timeZone: 'Asia/Kolkata' })).toEqual({ ok: true, set: { 'emailReminders.timeZone': 'Asia/Kolkata' }, unset: [] });
    expect(parseEmailPrefsUpdate({ timeZone: null })).toEqual({ ok: true, set: {}, unset: ['emailReminders.timeZone'] });
  });

  const rejected: Array<[string, unknown]> = [
    ['not an object', 'enabled'],
    ['null body', null],
    ['an array', [{ enabled: true }]],
    ['an empty object', {}],
    ['an unknown key', { enabled: true, email: 'x@evil.test' }],
    ['an address field', { to: 'x@evil.test' }],
    ['a nested path', { 'emailReminders.enabled': true }],
    ['a non-boolean toggle', { enabled: 'true' }],
    ['a number as a toggle', { digestEnabled: 1 }],
    ['an impossible time', { quietHoursStart: '24:00' }],
    ['a time without zero padding', { digestTime: '7:30' }],
    ['a non-string time', { digestTime: 730 }],
    ['an unsupported buffer', { bufferMinutes: 45 }],
    ['a string buffer', { bufferMinutes: '60' }],
    ['an offset as a zone', { timeZone: '+05:30' }],
    ['an empty zone', { timeZone: '' }],
    ['one bad field among good ones', { enabled: true, bufferMinutes: 7 }],
  ];
  it.each(rejected)('rejects %s whole', (_name, body) => {
    expect(parseEmailPrefsUpdate(body).ok).toBe(false);
  });

  it('a prototype-pollution style body is just an unknown key', () => {
    expect(parseEmailPrefsUpdate(JSON.parse('{"__proto__":{"enabled":true}}')).ok).toBe(false);
  });
});

describe('isInQuietHours (same rule as the browser: end exclusive, wraps midnight, start == end is none)', () => {
  const at = (iso: string) => Date.parse(iso);
  it('a window that crosses midnight, read in the given zone', () => {
    // 22:30 - 07:00 in Asia/Kolkata (UTC+05:30)
    expect(isInQuietHours(at('2026-10-05T17:00:00Z'), 'Asia/Kolkata', '22:30', '07:00')).toBe(true); // 22:30 IST: inclusive start
    expect(isInQuietHours(at('2026-10-05T16:59:00Z'), 'Asia/Kolkata', '22:30', '07:00')).toBe(false); // 22:29
    expect(isInQuietHours(at('2026-10-05T01:29:00Z'), 'Asia/Kolkata', '22:30', '07:00')).toBe(true); // 06:59
    expect(isInQuietHours(at('2026-10-05T01:30:00Z'), 'Asia/Kolkata', '22:30', '07:00')).toBe(false); // 07:00: exclusive end
  });
  it('the zone decides, not the process clock: the same instant is quiet in one zone and not in another', () => {
    const instant = at('2026-10-05T03:00:00Z');
    expect(isInQuietHours(instant, 'UTC', '22:30', '07:00')).toBe(true);
    expect(isInQuietHours(instant, 'Asia/Kolkata', '22:30', '07:00')).toBe(false); // 08:30 IST
  });
  it('a same-day window, and no window when start equals end', () => {
    expect(isInQuietHours(at('2026-10-05T13:00:00Z'), 'UTC', '12:00', '14:00')).toBe(true);
    expect(isInQuietHours(at('2026-10-05T14:00:00Z'), 'UTC', '12:00', '14:00')).toBe(false);
    expect(isInQuietHours(at('2026-10-05T03:00:00Z'), 'UTC', '08:00', '08:00')).toBe(false);
  });
});
