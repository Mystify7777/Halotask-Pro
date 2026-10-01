import { describe, expect, it } from 'vitest';
import {
  addDays,
  getToday,
  isValidCalendarDate,
  isValidUtcOffsetMinutes,
  localDateAt,
} from '../src/utils/calendarDate';
import {
  DATE_NOT_TODAY,
  DATE_OUT_OF_RANGE,
  HISTORY_DAYS_MAX,
  MAX_COMPLETED_TASKS_PER_DAY,
  buildDateWindow,
  parseHistoryQuery,
  parseHistoryUpsert,
} from '../src/utils/historyValidators';

// 02:00 UTC on Sep 30 2026:
//   India (+05:30)        07:30 Sep 30      Los Angeles (PDT -07:00)  19:00 Sep 29
//   Kiritimati (+14:00)   16:00 Sep 30      Baker Island (-12:00)     14:00 Sep 29
const NOW = new Date('2026-09-30T02:00:00Z');
const IST = 330;
const LA_SUMMER = -420;
const LA_WINTER = -480;
const UTC_PLUS_14 = 840;
const UTC_MINUS_12 = -720;

// Independent ground truth: the platform's own timezone database, not our arithmetic.
const intlDate = (timeZone: string, iso: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
};

const task = (over: Record<string, unknown> = {}) => ({
  taskId: '665f1c2e9b1e8a0012345678',
  title: 'Write report',
  estimatedMinutes: 30,
  ...over,
});

const validBody = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-30',
  utcOffsetMinutes: IST,
  completedCount: 1,
  workDoneMinutes: 30,
  completedTasks: [task()],
  ...over,
});

const query = (over: Record<string, unknown> = {}) => ({
  days: '7',
  endDate: '2026-09-30',
  utcOffsetMinutes: String(IST),
  ...over,
});

const upsertToday = (body: unknown, now = NOW) => parseHistoryUpsert(body, { mode: 'today', now });
const todayAccepted = (date: string, utcOffsetMinutes: number, now: Date) =>
  upsertToday(validBody({ date, utcOffsetMinutes }), now).ok;

describe('calendarDate primitives', () => {
  it('accepts only real calendar dates in strict YYYY-MM-DD form', () => {
    expect(isValidCalendarDate('2026-09-30')).toBe(true);
    expect(isValidCalendarDate('2028-02-29')).toBe(true); // leap day
    for (const bad of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-9-30', '26-09-30', '2026-09-30T00:00:00Z', '', null, undefined, 20260930, ['2026-09-30']]) {
      expect(isValidCalendarDate(bad)).toBe(false);
    }
    expect(isValidCalendarDate('2027-02-29')).toBe(false); // not a leap year
  });

  it('accepts only integer offsets inside the real-world range', () => {
    for (const ok of [0, 330, -420, 840, -720, 345, -210]) expect(isValidUtcOffsetMinutes(ok)).toBe(true);
    for (const bad of [841, -721, 330.5, Number.NaN, Number.POSITIVE_INFINITY, '330', null, undefined, [330], {}]) {
      expect(isValidUtcOffsetMinutes(bad)).toBe(false);
    }
  });

  it('does pure calendar arithmetic across month/year boundaries', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-09-30', -6)).toBe('2026-09-24');
  });
});

describe('one calendar-date convention: date = instant shifted by the declared offset', () => {
  // [zone, offsetMinutes, instant just before local midnight, instant at local midnight, date before, date after]
  const midnights: [string, number, string, string][] = [
    ['Pacific/Kiritimati', UTC_PLUS_14, '2026-09-30T09:59:59Z', '2026-09-30T10:00:00Z'], // UTC+14
    ['Etc/GMT+12', UTC_MINUS_12, '2026-09-30T11:59:59Z', '2026-09-30T12:00:00Z'], // UTC-12
    ['Asia/Calcutta', IST, '2026-09-30T18:29:59Z', '2026-09-30T18:30:00Z'], // India +05:30
    ['America/Los_Angeles', LA_SUMMER, '2026-10-01T06:59:59Z', '2026-10-01T07:00:00Z'], // Los Angeles PDT
    ['America/Los_Angeles', LA_WINTER, '2026-12-01T07:59:59Z', '2026-12-01T08:00:00Z'], // Los Angeles PST
  ];

  it.each(midnights)('%s (%i min): localDateAt flips exactly at local midnight, matching Intl', (zone, offset, before, at) => {
    expect(localDateAt(new Date(before), offset)).toBe(intlDate(zone, before));
    expect(localDateAt(new Date(at), offset)).toBe(intlDate(zone, at));
    expect(localDateAt(new Date(at), offset)).toBe(addDays(localDateAt(new Date(before), offset), 1));
  });

  it.each(midnights)('%s: server accepts exactly the local "today" and rejects the neighbouring days', (zone, offset, before, at) => {
    const hoursAfter = new Date(new Date(at).getTime() + 2 * 3600_000); // well past midnight
    const hoursBefore = new Date(new Date(before).getTime() - 2 * 3600_000); // well before midnight

    const newDay = intlDate(zone, at);
    const prevDay = addDays(newDay, -1);
    expect(intlDate(zone, hoursAfter.toISOString())).toBe(newDay);
    expect(intlDate(zone, hoursBefore.toISOString())).toBe(prevDay);

    // 2h after local midnight: only the new day is "today".
    expect(todayAccepted(newDay, offset, hoursAfter)).toBe(true);
    expect(todayAccepted(prevDay, offset, hoursAfter)).toBe(false);
    expect(todayAccepted(addDays(newDay, 1), offset, hoursAfter)).toBe(false);
    // 2h before local midnight: only the previous day is "today".
    expect(todayAccepted(prevDay, offset, hoursBefore)).toBe(true);
    expect(todayAccepted(newDay, offset, hoursBefore)).toBe(false);
  });

  it.each(midnights)('%s: exactly one date is "today" at every instant, including one second either side of midnight', (zone, offset, before, at) => {
    const newDay = intlDate(zone, at);
    const prevDay = addDays(newDay, -1);

    // 1s before local midnight: ONLY the previous day. At local midnight: ONLY the new day.
    expect(todayAccepted(prevDay, offset, new Date(before))).toBe(true);
    expect(todayAccepted(newDay, offset, new Date(before))).toBe(false);
    expect(todayAccepted(newDay, offset, new Date(at))).toBe(true);
    expect(todayAccepted(prevDay, offset, new Date(at))).toBe(false);
    // ...and never a third date.
    expect(todayAccepted(addDays(newDay, 1), offset, new Date(at))).toBe(false);
    expect(todayAccepted(addDays(prevDay, -1), offset, new Date(before))).toBe(false);
  });

  it('the same instant is a different "today" for different declared offsets (no hidden UTC day)', () => {
    // 02:00Z: UTC+14 and India are on Sep 30, Los Angeles and UTC-12 are still on Sep 29.
    expect(getToday(UTC_PLUS_14, NOW)).toBe('2026-09-30');
    expect(getToday(IST, NOW)).toBe('2026-09-30');
    expect(getToday(LA_SUMMER, NOW)).toBe('2026-09-29');
    expect(getToday(UTC_MINUS_12, NOW)).toBe('2026-09-29');

    expect(todayAccepted('2026-09-29', LA_SUMMER, NOW)).toBe(true);
    expect(todayAccepted('2026-09-30', LA_SUMMER, NOW)).toBe(false); // the UTC date is NOT today in LA
    expect(todayAccepted('2026-09-30', IST, NOW)).toBe(true);
    expect(todayAccepted('2026-09-29', IST, NOW)).toBe(false);
  });
});

describe('DST transitions (Los Angeles 2026)', () => {
  // Spring forward 2026-03-08 10:00Z (02:00 PST → 03:00 PDT); fall back 2026-11-01 09:00Z (02:00 PDT → 01:00 PST).
  it('the date is continuous across the spring-forward instant', () => {
    const before = '2026-03-08T09:59:59Z'; // 01:59:59 PST, offset -480
    const after = '2026-03-08T10:00:00Z'; //  03:00:00 PDT, offset -420
    expect(localDateAt(new Date(before), LA_WINTER)).toBe(intlDate('America/Los_Angeles', before));
    expect(localDateAt(new Date(after), LA_SUMMER)).toBe(intlDate('America/Los_Angeles', after));
    expect(intlDate('America/Los_Angeles', before)).toBe('2026-03-08');
    expect(intlDate('America/Los_Angeles', after)).toBe('2026-03-08');
    expect(todayAccepted('2026-03-08', LA_WINTER, new Date(before))).toBe(true);
    expect(todayAccepted('2026-03-08', LA_SUMMER, new Date(after))).toBe(true);
  });

  it('local midnight moves by an hour in UTC after the change, and the declared offset tracks it', () => {
    const lastPstMidnight = '2026-03-08T08:00:00Z'; // 00:00 Mar 8 PST (-480)
    const firstPdtMidnight = '2026-03-09T07:00:00Z'; // 00:00 Mar 9 PDT (-420)
    expect(localDateAt(new Date(lastPstMidnight), LA_WINTER)).toBe('2026-03-08');
    expect(localDateAt(new Date(firstPdtMidnight), LA_SUMMER)).toBe('2026-03-09');
    expect(intlDate('America/Los_Angeles', lastPstMidnight)).toBe('2026-03-08');
    expect(intlDate('America/Los_Angeles', firstPdtMidnight)).toBe('2026-03-09');

    // 02:00 after the first PDT midnight: only Mar 9 is today when the client sends its current offset.
    const later = new Date('2026-03-09T09:00:00Z');
    expect(todayAccepted('2026-03-09', LA_SUMMER, later)).toBe(true);
    expect(todayAccepted('2026-03-08', LA_SUMMER, later)).toBe(false);
  });

  it('the date is continuous across the fall-back instant, including the repeated hour', () => {
    const beforeBack = '2026-11-01T08:59:59Z'; // 01:59:59 PDT (-420)
    const afterBack = '2026-11-01T09:00:00Z'; //  01:00:00 PST (-480) — the repeated hour
    expect(intlDate('America/Los_Angeles', beforeBack)).toBe('2026-11-01');
    expect(intlDate('America/Los_Angeles', afterBack)).toBe('2026-11-01');
    expect(todayAccepted('2026-11-01', LA_SUMMER, new Date(beforeBack))).toBe(true);
    expect(todayAccepted('2026-11-01', LA_WINTER, new Date(afterBack))).toBe(true);
    expect(localDateAt(new Date(afterBack), LA_WINTER)).toBe('2026-11-01');
  });

  it('a 7-day window across both DST changes is contiguous (pure calendar arithmetic)', () => {
    expect(buildDateWindow(7, '2026-03-10')).toEqual([
      '2026-03-04', '2026-03-05', '2026-03-06', '2026-03-07', '2026-03-08', '2026-03-09', '2026-03-10',
    ]);
    expect(buildDateWindow(7, '2026-11-03')).toEqual([
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03',
    ]);
  });
});

describe('date boundary around midnight (India)', () => {
  const at = (iso: string) => new Date(iso);
  // India midnight into Oct 1 is 2026-09-30T18:30:00Z. Each instant has exactly ONE valid "today".
  it.each([
    ['one hour before midnight', '2026-09-30T17:30:00Z', '2026-09-30'],
    ['one second before midnight', '2026-09-30T18:29:59Z', '2026-09-30'],
    ['at midnight', '2026-09-30T18:30:00Z', '2026-10-01'],
    ['one second after midnight', '2026-09-30T18:30:01Z', '2026-10-01'],
    ['one hour after midnight', '2026-09-30T19:30:00Z', '2026-10-01'],
  ])('%s: only %s… is today', (_label, instant, expectedToday) => {
    const other = expectedToday === '2026-09-30' ? '2026-10-01' : '2026-09-30';
    expect(todayAccepted(expectedToday, IST, at(instant))).toBe(true);
    expect(todayAccepted(other, IST, at(instant))).toBe(false);
  });
});

describe('parseHistoryQuery', () => {
  it('accepts a complete query', () => {
    expect(parseHistoryQuery(query(), NOW)).toEqual({
      ok: true,
      value: { days: 7, endDate: '2026-09-30', utcOffsetMinutes: IST },
    });
    expect(parseHistoryQuery(query({ days: '1' }), NOW)).toMatchObject({ ok: true, value: { days: 1 } });
    expect(parseHistoryQuery(query({ days: String(HISTORY_DAYS_MAX) }), NOW)).toMatchObject({ ok: true, value: { days: 90 } });
    expect(parseHistoryQuery({ endDate: '2026-09-29', utcOffsetMinutes: '-420' }, NOW)).toMatchObject({
      ok: true,
      value: { days: 7, endDate: '2026-09-29', utcOffsetMinutes: LA_SUMMER },
    });
  });

  it('days defaults to 7 when omitted', () => {
    const { days: _omit, ...withoutDays } = query();
    expect(parseHistoryQuery(withoutDays, NOW)).toMatchObject({ ok: true, value: { days: 7 } });
  });

  it('has NO UTC fallback: endDate and utcOffsetMinutes are both required', () => {
    expect(parseHistoryQuery({}, NOW).ok).toBe(false);
    expect(parseHistoryQuery({ days: '7' }, NOW).ok).toBe(false); // the old "legacy" call shape
    expect(parseHistoryQuery({ days: '7', endDate: '2026-09-30' }, NOW).ok).toBe(false); // no offset
    expect(parseHistoryQuery({ days: '7', utcOffsetMinutes: '330' }, NOW).ok).toBe(false); // no endDate
  });

  it.each([
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-3'],
    ['fractional', '7.5'],
    ['exponent', '1e1'],
    ['hex', '0x10'],
    ['padded', ' 7'],
    ['signed', '+7'],
    ['text', 'abc'],
    ['NaN', 'NaN'],
    ['Infinity', 'Infinity'],
    ['over the maximum', '91'],
    ['huge', '999999999999'],
  ])('rejects malformed days (%s) instead of coercing to a default', (_label, days) => {
    expect(parseHistoryQuery(query({ days }), NOW).ok).toBe(false);
  });

  it.each([
    ['empty', ''],
    ['text', 'IST'],
    ['fractional', '330.5'],
    ['signed plus', '+330'],
    ['exponent', '3e2'],
    ['too large', '841'],
    ['too small', '-721'],
    ['huge', '99999'],
    ['NaN', 'NaN'],
  ])('rejects malformed utcOffsetMinutes (%s)', (_label, utcOffsetMinutes) => {
    expect(parseHistoryQuery(query({ utcOffsetMinutes }), NOW).ok).toBe(false);
  });

  it('rejects repeated and structured query parameters', () => {
    expect(parseHistoryQuery(query({ days: ['7', '8'] }), NOW).ok).toBe(false);
    expect(parseHistoryQuery(query({ days: { $gt: '1' } }), NOW).ok).toBe(false);
    expect(parseHistoryQuery(query({ endDate: ['2026-09-30', '2026-09-29'] }), NOW).ok).toBe(false);
    expect(parseHistoryQuery(query({ utcOffsetMinutes: ['330', '0'] }), NOW).ok).toBe(false);
  });

  it('rejects invalid, future and historical endDate for the declared offset', () => {
    for (const endDate of ['2026-02-30', 'yesterday', '2026-10-01', '2026-09-28']) {
      expect(parseHistoryQuery(query({ endDate }), NOW).ok).toBe(false);
    }
    // Same instant, different declared offset → different valid endDate.
    expect(parseHistoryQuery(query({ endDate: '2026-09-29', utcOffsetMinutes: '-420' }), NOW).ok).toBe(true);
    expect(parseHistoryQuery(query({ endDate: '2026-09-30', utcOffsetMinutes: '-420' }), NOW).ok).toBe(false);
  });
});

describe('buildDateWindow', () => {
  it('ends at the client-supplied local today', () => {
    expect(buildDateWindow(3, '2026-09-29')).toEqual(['2026-09-27', '2026-09-28', '2026-09-29']);
  });

  it('is independent of the server process timezone', () => {
    const nodeEnv = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const original = nodeEnv.TZ;
    try {
      for (const tz of ['UTC', 'Asia/Calcutta', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
        nodeEnv.TZ = tz;
        expect(buildDateWindow(3, '2026-03-02')).toEqual(['2026-02-28', '2026-03-01', '2026-03-02']);
        expect(localDateAt(NOW, IST)).toBe('2026-09-30');
        expect(getToday(LA_SUMMER, NOW)).toBe('2026-09-29');
      }
    } finally {
      if (original === undefined) delete nodeEnv.TZ;
      else nodeEnv.TZ = original;
    }
  });
});

describe('parseHistoryUpsert — today semantics', () => {
  it('accepts a valid payload and does not persist the offset field', () => {
    const result = upsertToday(validBody());
    expect(result).toEqual({
      ok: true,
      value: {
        date: '2026-09-30',
        completedCount: 1,
        workDoneMinutes: 30,
        completedTasks: [task()],
      },
    });
  });

  it('accepts an empty day and offline-created local task ids', () => {
    expect(upsertToday(validBody({ completedCount: 0, workDoneMinutes: 0, completedTasks: [] })).ok).toBe(true);
    expect(upsertToday(validBody({ completedTasks: [task({ taskId: 'local-1764500000000-ab12cd' })] })).ok).toBe(true);
  });

  it('requires a valid declared offset (no default, no UTC fallback)', () => {
    const { utcOffsetMinutes: _omit, ...withoutOffset } = validBody();
    expect(upsertToday(withoutOffset).ok).toBe(false);
    for (const utcOffsetMinutes of [null, '330', 330.5, 841, -721, Number.NaN, [330], {}]) {
      expect(upsertToday(validBody({ utcOffsetMinutes })).ok).toBe(false);
    }
  });

  it('"today" is the date at the declared offset, not the UTC date', () => {
    expect(upsertToday(validBody({ date: '2026-09-29', utcOffsetMinutes: LA_SUMMER })).ok).toBe(true);
    expect(upsertToday(validBody({ date: '2026-09-30', utcOffsetMinutes: LA_SUMMER })).ok).toBe(false);
    expect(upsertToday(validBody({ date: '2026-09-30', utcOffsetMinutes: IST })).ok).toBe(true);
    expect(upsertToday(validBody({ date: '2026-09-29', utcOffsetMinutes: IST })).ok).toBe(false);
  });

  it('rejects historical and future dates', () => {
    expect(upsertToday(validBody({ date: '2026-09-28' })).ok).toBe(false);
    expect(upsertToday(validBody({ date: '2026-10-01' })).ok).toBe(false);
    expect(upsertToday(validBody({ date: '2000-01-01' })).ok).toBe(false);
    expect(upsertToday(validBody({ date: '9999-12-31' })).ok).toBe(false);
  });

  it.each([undefined, null, '', '2026-02-30', '2026-9-30', 'today', 20260930, ['2026-09-30']])(
    'rejects invalid date %j',
    (date) => {
      expect(upsertToday(validBody({ date })).ok).toBe(false);
    },
  );

  it('rejects a non-object body', () => {
    for (const body of [null, undefined, 'x', 5, [], [validBody()]]) {
      expect(upsertToday(body).ok).toBe(false);
    }
  });
});

describe('parseHistoryUpsert — backfill (PUT /:date)', () => {
  const backfill = (pathDate: string, body: unknown = validBody({ date: undefined })) =>
    parseHistoryUpsert(body, { mode: 'backfill', pathDate, now: NOW });

  it('accepts today and the previous 6 days, taking the date from the path', () => {
    expect(backfill('2026-09-30')).toMatchObject({ ok: true, value: { date: '2026-09-30' } });
    expect(backfill('2026-09-29')).toMatchObject({ ok: true, value: { date: '2026-09-29' } });
    expect(backfill('2026-09-24')).toMatchObject({ ok: true }); // oldest allowed: today - 6
  });

  it('rejects older than the retention window, future dates and invalid paths', () => {
    expect(backfill('2026-09-23').ok).toBe(false);
    expect(backfill('2026-10-01').ok).toBe(false);
    expect(backfill('2026-02-30').ok).toBe(false);
    expect(backfill('not-a-date').ok).toBe(false);
  });

  it('is relative to the declared offset (Los Angeles is a day behind India at this instant)', () => {
    const la = validBody({ date: undefined, utcOffsetMinutes: LA_SUMMER });
    expect(backfill('2026-09-29', la).ok).toBe(true); // LA today
    expect(backfill('2026-09-30', la).ok).toBe(false); // future for LA
    expect(backfill('2026-09-23', la).ok).toBe(true); // LA oldest (today - 6)
  });

  it('requires the offset and rejects a body date that disagrees with the path', () => {
    const { utcOffsetMinutes: _omit, ...noOffset } = validBody({ date: undefined });
    expect(backfill('2026-09-29', noOffset).ok).toBe(false);
    expect(backfill('2026-09-29', validBody({ date: '2026-09-28' })).ok).toBe(false);
    expect(backfill('2026-09-29', validBody({ date: '2026-09-29' })).ok).toBe(true);
  });
});

describe('parseHistoryUpsert — numeric and task validation', () => {
  it.each([
    ['negative count', { completedCount: -1 }],
    ['fractional count', { completedCount: 1.5 }],
    ['NaN count', { completedCount: Number.NaN }],
    ['Infinity count', { completedCount: Number.POSITIVE_INFINITY }],
    ['string count', { completedCount: '1' }],
    ['null count', { completedCount: null }],
    ['missing count', { completedCount: undefined }],
    ['excessive count', { completedCount: MAX_COMPLETED_TASKS_PER_DAY + 1 }],
    ['negative minutes', { workDoneMinutes: -5 }],
    ['Infinity minutes', { workDoneMinutes: Number.POSITIVE_INFINITY }],
    ['string minutes', { workDoneMinutes: '30' }],
    ['excessive minutes', { workDoneMinutes: 1e12 }],
    ['count that disagrees with tasks', { completedCount: 2 }],
    ['minutes that disagree with tasks', { workDoneMinutes: 31 }],
  ])('rejects %s rather than coercing it to a valid-looking zero', (_label, over) => {
    expect(upsertToday(validBody(over)).ok).toBe(false);
  });

  it('JSON null/NaN round trip (a serialized NaN arrives as null) is rejected, not zeroed', () => {
    const wire = JSON.parse(JSON.stringify({ ...validBody(), workDoneMinutes: Number.NaN }));
    expect(upsertToday(wire).ok).toBe(false);
  });

  it('rejects non-array and oversized completedTasks', () => {
    expect(upsertToday(validBody({ completedTasks: 'nope' })).ok).toBe(false);
    expect(upsertToday(validBody({ completedTasks: undefined })).ok).toBe(false);
    const many = Array.from({ length: MAX_COMPLETED_TASKS_PER_DAY + 1 }, (_, i) => task({ taskId: `t${i}`, estimatedMinutes: 0 }));
    expect(
      upsertToday(validBody({ completedCount: many.length, workDoneMinutes: 0, completedTasks: many })).ok,
    ).toBe(false);
  });

  it('accepts exactly the maximum number of completed tasks', () => {
    const max = Array.from({ length: MAX_COMPLETED_TASKS_PER_DAY }, (_, i) => task({ taskId: `t${i}`, estimatedMinutes: 1 }));
    expect(
      upsertToday(validBody({ completedCount: max.length, workDoneMinutes: max.length, completedTasks: max })).ok,
    ).toBe(true);
  });

  it.each([
    ['non-object entry', 'task'],
    ['null entry', null],
    ['array entry', []],
    ['missing taskId', task({ taskId: undefined })],
    ['empty taskId', task({ taskId: '' })],
    ['numeric taskId', task({ taskId: 123 })],
    ['oversized taskId', task({ taskId: 'a'.repeat(65) })],
    ['taskId with illegal characters', task({ taskId: '../etc/passwd' })],
    ['taskId with operator characters', task({ taskId: '{"$ne":1}' })],
    ['missing title', task({ title: undefined })],
    ['blank title', task({ title: '   ' })],
    ['non-string title', task({ title: 42 })],
    ['oversized title', task({ title: 'x'.repeat(201) })],
    ['negative estimatedMinutes', task({ estimatedMinutes: -1 })],
    ['non-finite estimatedMinutes', task({ estimatedMinutes: Number.POSITIVE_INFINITY })],
    ['string estimatedMinutes', task({ estimatedMinutes: '30' })],
    ['excessive estimatedMinutes', task({ estimatedMinutes: 100_001 })],
  ])('rejects malformed completed task: %s', (_label, entry) => {
    expect(
      upsertToday(validBody({ completedCount: 1, workDoneMinutes: 30, completedTasks: [entry] })).ok,
    ).toBe(false);
  });

  it('rejects duplicate taskIds within one day (prevents double-counting)', () => {
    const dup = [task({ estimatedMinutes: 10 }), task({ estimatedMinutes: 10 })];
    expect(upsertToday(validBody({ completedCount: 2, workDoneMinutes: 20, completedTasks: dup })).ok).toBe(false);
  });

  it('trims titles and drops unknown fields instead of persisting them', () => {
    const result = upsertToday(
      validBody({ completedTasks: [{ ...task({ title: '  Write report  ' }), extra: 'x', $set: { admin: true } }], userId: 'someone-else' }),
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value.completedTasks).toEqual([task({ title: 'Write report' })]);
      expect(result.value).not.toHaveProperty('userId');
      expect(result.value).not.toHaveProperty('utcOffsetMinutes');
    }
  });
});

describe('which failures carry a retry-able DATE_* code', () => {
  it('a date that is not today (today route, GET endDate) is tagged DATE_NOT_TODAY', () => {
    const today = upsertToday(validBody({ date: '2026-09-29' }));
    expect(today).toMatchObject({ ok: false, code: DATE_NOT_TODAY });
    const future = upsertToday(validBody({ date: '2026-10-01' }));
    expect(future).toMatchObject({ ok: false, code: DATE_NOT_TODAY });
    expect(parseHistoryQuery(query({ endDate: '2026-09-29' }), NOW)).toMatchObject({ ok: false, code: DATE_NOT_TODAY });
  });

  it('a backfill date outside the 7-day window is tagged DATE_OUT_OF_RANGE', () => {
    const r = parseHistoryUpsert(validBody({ date: undefined }), { mode: 'backfill', pathDate: '2026-10-01', now: NOW });
    expect(r).toMatchObject({ ok: false, code: DATE_OUT_OF_RANGE });
  });

  it('payload errors carry NO code: they can never succeed on retry', () => {
    for (const result of [
      upsertToday(validBody({ completedCount: -1 })),
      upsertToday(validBody({ date: '2026-02-30' })),
      upsertToday(validBody({ utcOffsetMinutes: 900 })),
      upsertToday(validBody({ completedTasks: 'nope' })),
      parseHistoryQuery(query({ days: '0' }), NOW),
      parseHistoryQuery(query({ endDate: 'garbage' }), NOW),
      parseHistoryQuery({}, NOW),
    ]) {
      expect(result.ok).toBe(false);
      expect(result).not.toHaveProperty('code');
    }
  });
});

// ── Exactly one "today" at every point around local midnight ──────────────────

describe('local midnight matrix: exactly one date is today, yesterday and tomorrow are rejected', () => {
  const MIN = 60_000;
  // [label, zone, offset, instant of 00:00 local on date D]. Offsets are the ones in force at the instants tested.
  const days: [string, string, number, string][] = [
    ['UTC+14', 'Pacific/Kiritimati', UTC_PLUS_14, '2026-09-30T10:00:00Z'],
    ['UTC-12', 'Etc/GMT+12', UTC_MINUS_12, '2026-09-30T12:00:00Z'],
    ['India +05:30', 'Asia/Calcutta', IST, '2026-09-30T18:30:00Z'],
    ['Los Angeles PDT', 'America/Los_Angeles', LA_SUMMER, '2026-10-01T07:00:00Z'],
    ['Los Angeles PST', 'America/Los_Angeles', LA_WINTER, '2026-12-01T08:00:00Z'],
  ];
  const minutesAfterMidnight: [string, number][] = [
    ['00:00', 0],
    ['00:15', 15],
    ['00:29', 29],
    ['00:30', 30],
    ['23:30', 23 * 60 + 30],
    ['23:45', 23 * 60 + 45],
    ['23:59', 23 * 60 + 59],
  ];

  // The same checks, applied to a concrete (zone, offset, instant).
  const expectExactlyToday = (zone: string, offset: number, instant: Date) => {
    const truth = intlDate(zone, instant.toISOString()); // independent of our arithmetic
    const yesterday = addDays(truth, -1);
    const tomorrow = addDays(truth, 1);

    expect(getToday(offset, instant)).toBe(truth);

    // PUT /today: only the real local date.
    expect(todayAccepted(truth, offset, instant)).toBe(true);
    expect(todayAccepted(yesterday, offset, instant)).toBe(false);
    expect(todayAccepted(tomorrow, offset, instant)).toBe(false);
    expect(upsertToday(validBody({ date: yesterday, utcOffsetMinutes: offset }), instant)).toMatchObject({ ok: false, code: DATE_NOT_TODAY });
    expect(upsertToday(validBody({ date: tomorrow, utcOffsetMinutes: offset }), instant)).toMatchObject({ ok: false, code: DATE_NOT_TODAY });

    // GET endDate: only the real local date.
    const q = (endDate: string) => parseHistoryQuery(query({ endDate, utcOffsetMinutes: String(offset) }), instant);
    expect(q(truth).ok).toBe(true);
    expect(q(yesterday).ok).toBe(false);
    expect(q(tomorrow).ok).toBe(false);

    // PUT /:date backfill: today and earlier days accepted, tomorrow is a future date and rejected.
    const bf = (date: string) =>
      parseHistoryUpsert(validBody({ date: undefined, utcOffsetMinutes: offset }), { mode: 'backfill', pathDate: date, now: instant }).ok;
    expect(bf(truth)).toBe(true);
    expect(bf(yesterday)).toBe(true);
    expect(bf(tomorrow)).toBe(false);
  };

  describe.each(days)('%s', (_label, zone, offset, midnight) => {
    it.each(minutesAfterMidnight)('at %s local', (_t, minutes) => {
      const instant = new Date(new Date(midnight).getTime() + minutes * MIN);
      expectExactlyToday(zone, offset, instant);
    });

    it('flips exactly at 23:59:59 → 00:00:00 with no overlap', () => {
      const nextMidnight = new Date(new Date(midnight).getTime() + 24 * 60 * MIN);
      const before = new Date(nextMidnight.getTime() - 1000);
      const dayD = intlDate(zone, before.toISOString());
      const dayNext = intlDate(zone, nextMidnight.toISOString());
      expect(dayNext).toBe(addDays(dayD, 1));
      expectExactlyToday(zone, offset, before);
      expectExactlyToday(zone, offset, nextMidnight);
      expect(todayAccepted(dayD, offset, nextMidnight)).toBe(false);
      expect(todayAccepted(dayNext, offset, before)).toBe(false);
    });
  });

  describe('Los Angeles DST days (the offset in force changes during the day)', () => {
    // Spring forward 2026-03-08: 00:xx is PST (-480), 23:xx is PDT (-420).
    // Fall back    2026-11-01: 00:xx is PDT (-420), 23:xx is PST (-480).
    const dstInstants: [string, number, string][] = [
      ['spring-forward day 00:00 PST', LA_WINTER, '2026-03-08T08:00:00Z'],
      ['spring-forward day 00:15 PST', LA_WINTER, '2026-03-08T08:15:00Z'],
      ['spring-forward day 00:29 PST', LA_WINTER, '2026-03-08T08:29:00Z'],
      ['spring-forward day 00:30 PST', LA_WINTER, '2026-03-08T08:30:00Z'],
      ['spring-forward day 01:59:59 PST', LA_WINTER, '2026-03-08T09:59:59Z'],
      ['spring-forward day 03:00:00 PDT', LA_SUMMER, '2026-03-08T10:00:00Z'],
      ['spring-forward day 23:30 PDT', LA_SUMMER, '2026-03-09T06:30:00Z'],
      ['spring-forward day 23:45 PDT', LA_SUMMER, '2026-03-09T06:45:00Z'],
      ['spring-forward day 23:59 PDT', LA_SUMMER, '2026-03-09T06:59:00Z'],
      ['day after spring-forward 00:00 PDT', LA_SUMMER, '2026-03-09T07:00:00Z'],
      ['fall-back day 00:00 PDT', LA_SUMMER, '2026-11-01T07:00:00Z'],
      ['fall-back day 00:15 PDT', LA_SUMMER, '2026-11-01T07:15:00Z'],
      ['fall-back day 00:29 PDT', LA_SUMMER, '2026-11-01T07:29:00Z'],
      ['fall-back day 00:30 PDT', LA_SUMMER, '2026-11-01T07:30:00Z'],
      ['fall-back day 01:59:59 PDT (before the repeated hour)', LA_SUMMER, '2026-11-01T08:59:59Z'],
      ['fall-back day 01:00:00 PST (repeated hour)', LA_WINTER, '2026-11-01T09:00:00Z'],
      ['fall-back day 23:30 PST', LA_WINTER, '2026-11-02T07:30:00Z'],
      ['fall-back day 23:45 PST', LA_WINTER, '2026-11-02T07:45:00Z'],
      ['fall-back day 23:59 PST', LA_WINTER, '2026-11-02T07:59:00Z'],
      ['day after fall-back 00:00 PST', LA_WINTER, '2026-11-02T08:00:00Z'],
    ];

    it.each(dstInstants)('%s', (_label, offset, iso) => {
      expectExactlyToday('America/Los_Angeles', offset, new Date(iso));
    });
  });
});
