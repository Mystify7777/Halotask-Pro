import { describe, expect, it } from 'vitest';
import {
  COMPLETION_ID_PATTERN,
  MAX_EVENT_AGE_MS,
  MAX_FUTURE_SKEW_MS,
  isWithinEventWindow,
  parseStandaloneEvent,
  parseTaskCompletionEvent,
} from '../src/utils/completionValidators';

// Issue #47 — completion events: the window, the derived calendar day, and strict parsing.

const NOW = new Date('2026-11-05T04:00:00Z');
const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const at = (deltaMs: number) => new Date(NOW.getTime() + deltaMs);

describe('event window: 90 days back, 5 minutes ahead', () => {
  it('has the documented limits', () => {
    expect(MAX_EVENT_AGE_MS).toBe(90 * DAY);
    expect(MAX_FUTURE_SKEW_MS).toBe(5 * MINUTE);
  });

  it.each([
    ['10 minutes old', -10 * MINUTE, true],
    ['30 days old', -30 * DAY, true],
    ['89 days old', -89 * DAY, true],
    ['exactly 90 days old', -90 * DAY, true],
    ['91 days old', -91 * DAY, false],
    ['120 days old', -120 * DAY, false],
    ['now', 0, true],
    ['3 minutes in the future', 3 * MINUTE, true],
    ['exactly 5 minutes in the future', 5 * MINUTE, true],
    ['6 minutes in the future', 6 * MINUTE, false],
    ['a day in the future', DAY, false],
  ])('%s', (_label, delta, expected) => {
    expect(isWithinEventWindow(at(delta), NOW)).toBe(expected);
  });
});

describe('completion id', () => {
  it.each(['abc', 'C-1_x', '0'.repeat(64), '550e8400-e29b-41d4-a716-446655440000'])('accepts %s', (id) => {
    expect(COMPLETION_ID_PATTERN.test(id)).toBe(true);
  });
  it.each(['', 'a b', 'a/b', '0'.repeat(65), 'ünï'])('rejects %j', (id) => {
    expect(COMPLETION_ID_PATTERN.test(id)).toBe(false);
  });
});

const complete = (over: Record<string, unknown> = {}) => ({
  completionId: 'c1',
  completedAt: '2026-11-04T20:00:00Z',
  utcOffsetMinutes: 330,
  ...over,
});

describe('completionEvent on a task write: completed true', () => {
  it('derives localDate from completedAt + utcOffsetMinutes', () => {
    const parsed = parseTaskCompletionEvent(complete(), true);
    expect(parsed).toMatchObject({ ok: true, value: { kind: 'complete', completionId: 'c1', utcOffsetMinutes: 330, localDate: '2026-11-05' } });
  });

  it('a client-sent localDate is only checked: a matching one is accepted, a contradicting one is refused', () => {
    expect(parseTaskCompletionEvent(complete({ localDate: '2026-11-05' }), true).ok).toBe(true);
    const bad = parseTaskCompletionEvent(complete({ localDate: '2026-11-04' }), true);
    expect(bad).toEqual({ ok: false, message: 'completionEvent.localDate does not match completedAt at utcOffsetMinutes.' });
  });

  it('refuses a localDate that is not a real calendar date', () => {
    expect(parseTaskCompletionEvent(complete({ localDate: '2026-02-30' }), true).ok).toBe(false);
    expect(parseTaskCompletionEvent(complete({ localDate: 20261105 }), true).ok).toBe(false);
  });

  it('the same instant is a different local day per declared offset (UTC midnight boundary)', () => {
    const instant = '2026-11-04T00:00:00Z';
    const day = (offset: number) => {
      const parsed = parseTaskCompletionEvent(complete({ completedAt: instant, utcOffsetMinutes: offset }), true);
      return parsed.ok && parsed.value.kind === 'complete' ? parsed.value.localDate : null;
    };
    expect(day(0)).toBe('2026-11-04');
    expect(day(-1)).toBe('2026-11-03');
    expect(day(330)).toBe('2026-11-04');
    expect(day(-720)).toBe('2026-11-03');
    expect(day(840)).toBe('2026-11-04');
  });

  it('follows the offset the client declared, so a DST change needs no special case (Los Angeles, 1 Nov 2026)', () => {
    // 07:30 UTC on 1 Nov 2026 is 00:30 PDT (-420) the same day, but 23:30 PST (-480) the day before.
    const day = (offset: number) => {
      const parsed = parseTaskCompletionEvent(complete({ completedAt: '2026-11-01T07:30:00Z', utcOffsetMinutes: offset }), true);
      return parsed.ok && parsed.value.kind === 'complete' ? parsed.value.localDate : null;
    };
    expect(day(-420)).toBe('2026-11-01');
    expect(day(-480)).toBe('2026-10-31');
  });

  it('handles an offset written in completedAt itself', () => {
    const parsed = parseTaskCompletionEvent(complete({ completedAt: '2026-11-05T01:30:00+05:30', utcOffsetMinutes: 330 }), true);
    expect(parsed.ok && parsed.value.kind === 'complete' && parsed.value.completedAt.toISOString()).toBe('2026-11-04T20:00:00.000Z');
  });

  it.each([
    ['no completionId', { completionId: undefined }],
    ['a completionId with a space', { completionId: 'a b' }],
    ['a 65 character completionId', { completionId: '0'.repeat(65) }],
    ['a non-string completionId', { completionId: 7 }],
    ['no completedAt', { completedAt: undefined }],
    ['a completedAt without a zone', { completedAt: '2026-11-04T20:00:00' }],
    ['a completedAt that is not a date', { completedAt: 'yesterday' }],
    ['an impossible calendar date', { completedAt: '2026-02-30T10:00:00Z' }],
    ['a number for completedAt', { completedAt: 1762286400000 }],
    ['no utcOffsetMinutes', { utcOffsetMinutes: undefined }],
    ['a fractional offset', { utcOffsetMinutes: 330.5 }],
    ['a string offset', { utcOffsetMinutes: '330' }],
    ['an offset below -720', { utcOffsetMinutes: -721 }],
    ['an offset above 840', { utcOffsetMinutes: 841 }],
  ])('refuses %s', (_label, over) => {
    expect(parseTaskCompletionEvent(complete(over), true).ok).toBe(false);
  });

  it('refuses a non-object', () => {
    for (const raw of [null, 'c1', 5, ['c1'], true]) {
      expect(parseTaskCompletionEvent(raw, true)).toEqual({ ok: false, message: 'completionEvent must be an object.' });
    }
  });

  it('drops unknown keys instead of carrying them', () => {
    const parsed = parseTaskCompletionEvent(complete({ status: 'revoked', userId: 'x', title: 'y' }), true);
    expect(parsed.ok && Object.keys(parsed.value).sort()).toEqual(['completedAt', 'completionId', 'kind', 'localDate', 'utcOffsetMinutes']);
  });
});

describe('completionEvent on a task write: completed false (a revocation)', () => {
  const revoke = (over: Record<string, unknown> = {}) => ({ completionId: 'c1', revokedAt: '2026-11-05T01:00:00Z', ...over });

  it('accepts a revocation with the id', () => {
    expect(parseTaskCompletionEvent(revoke(), false)).toMatchObject({ ok: true, value: { kind: 'revoke', completionId: 'c1' } });
  });

  it('accepts one without the id (a device that never saw it): it means "the active completion of this task"', () => {
    const parsed = parseTaskCompletionEvent(revoke({ completionId: undefined }), false);
    expect(parsed.ok && parsed.value.kind === 'revoke' && parsed.value.completionId).toBeUndefined();
  });

  it('needs a valid revokedAt', () => {
    expect(parseTaskCompletionEvent(revoke({ revokedAt: undefined }), false).ok).toBe(false);
    expect(parseTaskCompletionEvent(revoke({ revokedAt: '2026-11-05T01:00:00' }), false).ok).toBe(false);
  });

  it('refuses a malformed id when one is given', () => {
    expect(parseTaskCompletionEvent(revoke({ completionId: 'a b' }), false).ok).toBe(false);
    expect(parseTaskCompletionEvent(revoke({ completionId: 3 }), false).ok).toBe(false);
  });

  it('the kind follows `completed`: a completion-shaped event with completed:false is not a revocation', () => {
    expect(parseTaskCompletionEvent(complete(), false).ok).toBe(false); // no revokedAt
  });
});

describe('POST /api/completion-events body', () => {
  const body = (over: Record<string, unknown> = {}) => ({
    type: 'complete',
    completionId: 'c1',
    taskId: 'local-1730000000000-ab12cd',
    title: '  Write report  ',
    estimatedMinutes: 30,
    completedAt: '2026-11-04T20:00:00Z',
    utcOffsetMinutes: 330,
    ...over,
  });

  it('accepts a complete event for a local-* task id, stored exactly as sent, with a trimmed title', () => {
    const parsed = parseStandaloneEvent(body());
    expect(parsed).toMatchObject({
      ok: true,
      value: { kind: 'complete', taskId: 'local-1730000000000-ab12cd', title: 'Write report', estimatedMinutes: 30, localDate: '2026-11-05' },
    });
  });

  it.each([
    ['an unknown type', { type: 'undo' }],
    ['no type', { type: undefined }],
    ['no taskId', { taskId: undefined }],
    ['a taskId with a slash', { taskId: 'a/b' }],
    ['a 65 character taskId', { taskId: 'a'.repeat(65) }],
    ['a blank title', { title: '   ' }],
    ['a title over 200 characters', { title: 'x'.repeat(201) }],
    ['a non-string title', { title: 5 }],
    ['no estimatedMinutes', { estimatedMinutes: undefined }],
    ['a negative estimate', { estimatedMinutes: -1 }],
    ['an estimate over the limit', { estimatedMinutes: 100_001 }],
    ['a string estimate', { estimatedMinutes: '30' }],
    ['a localDate that contradicts completedAt', { localDate: '2026-11-04' }],
  ])('refuses %s', (_label, over) => {
    expect(parseStandaloneEvent(body(over)).ok).toBe(false);
  });

  it('refuses a body that is not an object', () => {
    for (const raw of [undefined, null, 'x', 5, []]) {
      expect(parseStandaloneEvent(raw).ok).toBe(false);
    }
  });

  describe('revoke', () => {
    const revoke = (over: Record<string, unknown> = {}) => ({ type: 'revoke', completionId: 'c1', revokedAt: '2026-11-05T01:00:00Z', ...over });

    it('needs the completionId (there is no task to infer it from)', () => {
      expect(parseStandaloneEvent(revoke()).ok).toBe(true);
      expect(parseStandaloneEvent(revoke({ completionId: undefined })).ok).toBe(false);
    });

    it('takes an optional taskId and validates it', () => {
      expect(parseStandaloneEvent(revoke({ taskId: 'local-1-a' }))).toMatchObject({ ok: true, value: { taskId: 'local-1-a' } });
      expect(parseStandaloneEvent(revoke({ taskId: 'a/b' })).ok).toBe(false);
      expect(parseStandaloneEvent(revoke({ taskId: 5 })).ok).toBe(false);
    });

    it('needs a valid revokedAt', () => {
      expect(parseStandaloneEvent(revoke({ revokedAt: 'x' })).ok).toBe(false);
    });
  });
});
