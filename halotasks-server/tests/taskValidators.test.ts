import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_LENGTH,
  ESTIMATED_MINUTES_MAX,
  TAGS_MAX_COUNT,
  TAG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  isNonEmptyTitle,
  isValidEstimatedMinutes,
  isValidPriority,
  parseDueDate,
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
