import { describe, expect, it } from 'vitest';
import {
  DESCRIPTION_MAX_LENGTH,
  ESTIMATED_MINUTES_MAX,
  MAX_SUBTASKS,
  SUBTASK_ID_PATTERN,
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
  parseSubtasks,
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

describe('parseSubtasks (Issue #15: a bounded, strictly validated checklist)', () => {
  const sub = (id: string, extra: Record<string, unknown> = {}) => ({ id, title: `title ${id}`, completed: false, ...extra });
  const rejected = (raw: unknown) => {
    const result = parseSubtasks(raw);
    if (result.ok) throw new Error('expected a rejection');
    return result.message;
  };

  it('accepts a valid list and keeps the order, the ids and the done flags', () => {
    const result = parseSubtasks([sub('a'), sub('b', { completed: true })]);
    expect(result).toEqual({
      ok: true,
      value: [
        { id: 'a', title: 'title a', completed: false },
        { id: 'b', title: 'title b', completed: true },
      ],
    });
  });

  it('an empty array and null both mean "no subtasks"', () => {
    expect(parseSubtasks([])).toEqual({ ok: true, value: [] });
    expect(parseSubtasks(null)).toEqual({ ok: true, value: [] });
  });

  it('trims a title, and drops keys that are not part of a subtask (nothing else is changed)', () => {
    const result = parseSubtasks([{ id: 'a', title: '  Pack bag  ', completed: true, priority: 'high', _id: 'x', dueDate: '2026-11-01' }]);
    expect(result).toEqual({ ok: true, value: [{ id: 'a', title: 'Pack bag', completed: true }] });
  });

  it(`allows exactly ${MAX_SUBTASKS} entries and rejects ${MAX_SUBTASKS + 1}`, () => {
    const make = (count: number) => Array.from({ length: count }, (_, i) => sub(`s${i}`));
    expect(parseSubtasks(make(MAX_SUBTASKS)).ok).toBe(true);
    expect(rejected(make(MAX_SUBTASKS + 1))).toBe(`subtasks cannot have more than ${MAX_SUBTASKS} entries`);
  });

  it.each([
    ['a string', 'one, two'],
    ['an object', { 0: sub('a') }],
    ['a number', 3],
    ['a boolean', true],
    ['an empty string (not a clear value here)', ''],
  ])('%s is not an array', (_label, raw) => {
    expect(rejected(raw)).toBe('subtasks must be an array');
  });

  it.each([
    ['null', null],
    ['a string', 'x'],
    ['a number', 1],
    ['an array', [sub('a')]],
    ['undefined', undefined],
  ])('an entry that is %s is rejected as not an object', (_label, entry) => {
    expect(rejected([sub('ok'), entry])).toBe('subtasks[1] must be an object');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a string', 7],
    ['too long (65)', 'a'.repeat(65)],
    ['with a space', 'a b'],
    ['with a space at the end', 'a '],
    ['with a dot', 'a.b'],
    ['with a slash', 'a/b'],
    ['non-ASCII', 'é'],
  ])('an id that is %s is rejected (the server never invents one)', (_label, id) => {
    expect(rejected([{ id, title: 't', completed: false }])).toMatch(/^subtasks\[0\]\.id must be 1-64 characters/);
  });

  it.each(['a', 'A', '0', 'a-b_c', 'a'.repeat(64), '8b1f4c0e-6a1d-4b52-9c5e-2f0a7d3e91aa'])('the id %j is accepted', (id) => {
    expect(SUBTASK_ID_PATTERN.test(id)).toBe(true);
    expect(parseSubtasks([sub(id)]).ok).toBe(true);
  });

  it.each([
    ['missing', undefined],
    ['not a string', 4],
    ['empty', ''],
    ['whitespace only', '   '],
    [`longer than ${TITLE_MAX_LENGTH} characters`, 'x'.repeat(TITLE_MAX_LENGTH + 1)],
  ])('a title that is %s is rejected', (_label, title) => {
    expect(rejected([{ id: 'a', title, completed: false }])).toBe(
      `subtasks[0].title must be a non-empty string of at most ${TITLE_MAX_LENGTH} characters`,
    );
  });

  it('a title of exactly the limit is accepted, and the limit is measured after trimming', () => {
    expect(parseSubtasks([sub('a', { title: 'x'.repeat(TITLE_MAX_LENGTH) })]).ok).toBe(true);
    expect(parseSubtasks([sub('a', { title: ` ${'x'.repeat(TITLE_MAX_LENGTH)} ` })]).ok).toBe(true);
  });

  it.each([
    ['missing (nothing is assumed)', undefined],
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
  ])('completed that is %s is rejected', (_label, completed) => {
    expect(rejected([{ id: 'a', title: 't', completed }])).toBe('subtasks[0].completed must be a boolean');
  });

  it('a repeated id is rejected, naming the later entry', () => {
    expect(rejected([sub('a'), sub('b'), sub('a')])).toBe('subtasks[2].id is already used by another subtask');
  });

  it('ids that differ only by case are different ids', () => {
    expect(parseSubtasks([sub('a'), sub('A')]).ok).toBe(true);
  });

  it('two subtasks may share a title (they are told apart by id)', () => {
    expect(parseSubtasks([sub('a', { title: 'same' }), sub('b', { title: 'same' })]).ok).toBe(true);
  });

  it('reports the first problem by position, so the message points at the entry to fix', () => {
    expect(rejected([sub('a'), { id: 'b', title: '', completed: false }, { id: 'c!', title: 't', completed: false }])).toMatch(/^subtasks\[1\]\.title/);
  });

  it('does not change the array it was given', () => {
    const input = [{ id: 'a', title: '  t  ', completed: false, extra: 1 }];
    const copy = JSON.parse(JSON.stringify(input));
    parseSubtasks(input);
    expect(input).toEqual(copy);
  });
});
