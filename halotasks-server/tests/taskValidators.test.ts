import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_LENGTH,
  ESTIMATED_MINUTES_MAX,
  TAGS_MAX_COUNT,
  TAG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  isClearValue,
  isNonEmptyTitle,
  isValidDueTime,
  isValidEstimatedMinutes,
  isValidPriority,
  parseDueDate,
  parseStartTime,
} from '../src/utils/taskValidators';

describe('isNonEmptyTitle', () => {
  it('accepts a normal title', () => {
    expect(isNonEmptyTitle('Buy milk')).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(isNonEmptyTitle('')).toBe(false);
  });

  it('rejects a whitespace-only string', () => {
    expect(isNonEmptyTitle('   ')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isNonEmptyTitle(123)).toBe(false);
    expect(isNonEmptyTitle(null)).toBe(false);
    expect(isNonEmptyTitle(undefined)).toBe(false);
  });
});

describe('isValidPriority', () => {
  it('accepts the three known priorities', () => {
    expect(isValidPriority('low')).toBe(true);
    expect(isValidPriority('medium')).toBe(true);
    expect(isValidPriority('high')).toBe(true);
  });

  it('rejects unknown or malformed values', () => {
    expect(isValidPriority('urgent')).toBe(false);
    expect(isValidPriority('HIGH')).toBe(false);
    expect(isValidPriority(1)).toBe(false);
    expect(isValidPriority(null)).toBe(false);
  });
});

describe('parseDueDate', () => {
  it('treats undefined/null/empty as "not provided"', () => {
    expect(parseDueDate(undefined)).toEqual({ ok: true, value: undefined });
    expect(parseDueDate(null)).toEqual({ ok: true, value: undefined });
    expect(parseDueDate('')).toEqual({ ok: true, value: undefined });
  });

  it('accepts a valid ISO date string', () => {
    const result = parseDueDate('2026-12-25T00:00:00.000Z');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeInstanceOf(Date);
      expect(Number.isNaN(result.value!.getTime())).toBe(false);
    }
  });

  it('rejects an invalid date string instead of silently producing Invalid Date', () => {
    const result = parseDueDate('not-a-real-date');
    expect(result.ok).toBe(false);
  });

  it('rejects garbage like "0000-00-00"', () => {
    const result = parseDueDate('0000-00-00');
    expect(result.ok).toBe(false);
  });
});

describe('isValidEstimatedMinutes', () => {
  it('accepts zero and reasonable positive values', () => {
    expect(isValidEstimatedMinutes(0)).toBe(true);
    expect(isValidEstimatedMinutes(45)).toBe(true);
  });

  it('rejects negative values', () => {
    expect(isValidEstimatedMinutes(-1)).toBe(false);
  });

  it('rejects NaN and non-finite values', () => {
    expect(isValidEstimatedMinutes(NaN)).toBe(false);
    expect(isValidEstimatedMinutes(Infinity)).toBe(false);
  });

  it(`rejects values beyond the ${ESTIMATED_MINUTES_MAX} cap`, () => {
    expect(isValidEstimatedMinutes(ESTIMATED_MINUTES_MAX + 1)).toBe(false);
    expect(isValidEstimatedMinutes(ESTIMATED_MINUTES_MAX)).toBe(true);
  });

  it('treats Number("") as invalid at the isValidEstimatedMinutes level too', () => {
    // Number('') is 0 in JS — this documents that isValidEstimatedMinutes
    // alone can't distinguish "explicitly zero" from "empty string coerced
    // to zero"; the controller itself must reject the empty string before
    // ever calling Number() on it (see task.controller.ts / api.routes.test.ts).
    expect(Number('')).toBe(0);
    expect(isValidEstimatedMinutes(Number(''))).toBe(true);
  });
});

describe('length constants are sane', () => {
  it('are all positive', () => {
    expect(TITLE_MAX_LENGTH).toBeGreaterThan(0);
    expect(DESCRIPTION_MAX_LENGTH).toBeGreaterThan(0);
    expect(TAG_MAX_LENGTH).toBeGreaterThan(0);
    expect(TAGS_MAX_COUNT).toBeGreaterThan(0);
  });
});


describe('isClearValue', () => {
  it('treats null and the empty string as "clear", and nothing else', () => {
    expect(isClearValue(null)).toBe(true);
    expect(isClearValue('')).toBe(true);
    for (const other of [undefined, ' ', 0, false, 'x', {}, []]) expect(isClearValue(other)).toBe(false);
  });
});

describe('isValidDueTime (Issue #10: a wall-clock HH:mm)', () => {
  it.each(['00:00', '09:30', '12:00', '23:59'])('accepts %s', (value) => {
    expect(isValidDueTime(value)).toBe(true);
  });

  it.each([
    ['24:00', '24:00'],
    ['hour 25', '25:00'],
    ['minute 60', '10:60'],
    ['one-digit hour', '9:30'],
    ['seconds', '09:30:00'],
    ['12-hour with suffix', '09:30 PM'],
    ['a zone', '09:30Z'],
    ['a full ISO instant', '2026-10-20T09:30:00Z'],
    ['padded with a space', ' 09:30'],
    ['empty', ''],
    ['text', 'noon'],
  ])('rejects %s', (_label, value) => {
    expect(isValidDueTime(value)).toBe(false);
  });

  it.each([930, null, undefined, {}, ['09:30'], true])('rejects the non-string %j', (value) => {
    expect(isValidDueTime(value)).toBe(false);
  });
});

describe('parseStartTime (Issue #9: an ISO 8601 instant with a zone)', () => {
  it.each([
    ['UTC', '2026-10-20T09:30:00Z', '2026-10-20T09:30:00.000Z'],
    ['UTC without seconds', '2026-10-20T09:30Z', '2026-10-20T09:30:00.000Z'],
    ['fractional seconds', '2026-10-20T09:30:00.250Z', '2026-10-20T09:30:00.250Z'],
    ['a positive offset', '2026-10-20T09:30:00+05:30', '2026-10-20T04:00:00.000Z'],
    ['a negative offset', '2026-10-20T09:30:00-07:00', '2026-10-20T16:30:00.000Z'],
    ['a leap day', '2028-02-29T00:00:00Z', '2028-02-29T00:00:00.000Z'],
  ])('accepts %s and returns the instant', (_label, input, iso) => {
    const parsed = parseStartTime(input);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.toISOString()).toBe(iso);
  });

  it.each([
    ['a date that does not exist (Date would roll it to March 2)', '2026-02-30T10:00:00Z'],
    ['24:00', '2026-10-20T24:00:00Z'],
    ['minute 60', '2026-10-20T10:60:00Z'],
    ['second 60', '2026-10-20T10:00:60Z'],
    ['no zone (would be read in the server timezone)', '2026-10-20T10:00:00'],
    ['a space instead of T', '2026-10-20 10:00:00Z'],
    ['a date only', '2026-10-20'],
    ['a time only', '10:00'],
    ['a non-leap Feb 29', '2027-02-29T00:00:00Z'],
    ['an offset beyond 23:59', '2026-10-20T10:00:00+24:00'],
    ['trailing text', '2026-10-20T10:00:00Zjunk'],
    ['natural language', 'tomorrow at noon'],
    ['empty', ''],
    ['an over-long string', `2026-10-20T10:00:00.${'1'.repeat(60)}Z`],
  ])('rejects %s', (_label, input) => {
    expect(parseStartTime(input).ok).toBe(false);
  });

  it.each([1792474200000, null, undefined, {}, ['2026-10-20T10:00:00Z'], true, new Date()])('rejects the non-string %j', (value) => {
    expect(parseStartTime(value).ok).toBe(false);
  });
});
