import { describe, expect, it } from 'vitest';
import { TIME_ZONE_INVALID_MESSAGE, TIME_ZONE_MAX_LENGTH, isValidTimeZone, parseTimeZoneInput } from '../src/utils/timeZone';

// Issue #41 — which strings are accepted as a saved time zone. The runtime's own zone data (Intl) is the authority;
// these cases pin what must be accepted (IANA identifiers, including aliases and UTC) and what must never be (fixed
// offsets, which Node's Intl would otherwise take, junk, and non-strings).

describe('isValidTimeZone', () => {
  it.each([
    'UTC',
    'Asia/Kolkata',
    'Asia/Calcutta', // the alias many browsers still report for India
    'America/Los_Angeles',
    'America/Argentina/Buenos_Aires', // three segments
    'America/Port-au-Prince', // a hyphen
    'Pacific/Kiritimati', // +14:00
    'Pacific/Pago_Pago', // -11:00
    'Australia/Lord_Howe', // a 30-minute daylight-saving shift
    'Europe/London',
  ])('accepts the IANA identifier %s', (zone) => {
    expect(isValidTimeZone(zone)).toBe(true);
  });

  it.each([
    ['a positive fixed offset', '+05:30'],
    ['a negative fixed offset', '-08:00'],
    ['a compact offset', '+0530'],
    ['an offset-style string', 'UTC+05:30'],
    ['GMT with an offset', 'GMT+5'],
    ['an unknown region', 'Mars/Olympus_Mons'],
    ['a made-up word', 'NotAZone'],
    ['an empty string', ''],
    ['whitespace', '   '],
    ['a leading space', ' Asia/Kolkata'],
    ['a trailing newline', 'Asia/Kolkata\n'],
    ['a path traversal', '../etc/passwd'],
    ['a leading slash', '/Asia/Kolkata'],
    ['a double slash', 'Asia//Kolkata'],
    ['a query-looking value', 'Asia/Kolkata?x=1'],
    ['a NoSQL operator string', '$ne'],
  ])('rejects %s', (_label, value) => {
    expect(isValidTimeZone(value)).toBe(false);
  });

  it('rejects an identifier longer than the maximum, even a well-formed one', () => {
    expect(isValidTimeZone(`Asia/${'A'.repeat(TIME_ZONE_MAX_LENGTH)}`)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 330],
    ['an object', { $ne: null }],
    ['an array', ['UTC']],
    ['a boolean', true],
  ])('rejects %s without throwing', (_label, value) => {
    expect(isValidTimeZone(value)).toBe(false);
  });
});

describe('parseTimeZoneInput', () => {
  it('a valid identifier sets the preference', () => {
    expect(parseTimeZoneInput('Asia/Kolkata')).toEqual({ ok: true, value: 'Asia/Kolkata' });
  });

  it('null clears the preference', () => {
    expect(parseTimeZoneInput(null)).toEqual({ ok: true, value: null });
  });

  it.each([undefined, '', '+05:30', 'Nowhere/Land', 5, {}, []])('rejects %j rather than normalising it', (value) => {
    expect(parseTimeZoneInput(value)).toEqual({ ok: false, message: TIME_ZONE_INVALID_MESSAGE });
  });
});
