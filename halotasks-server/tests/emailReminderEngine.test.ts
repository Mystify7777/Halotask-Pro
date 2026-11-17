import { describe, expect, it } from 'vitest';
import {
  computeDigest,
  computeReminderEvents,
  DIGEST_SECTION_CAP,
  dueDayKey,
  exactDeadline,
  OVERDUE_EMAIL_WINDOW_MS,
  type EngineTask,
} from '../src/utils/emailReminderEngine';

// Issue #29, sections S3 and S6 — the pure engine. (Agreement with the browser is pinned in emailReminderParity.test.ts.)

const ALL = { dueSoonEnabled: true, overdueEnabled: true, workSessionSoonEnabled: true, startNowEnabled: true, bufferMinutes: 60 as 15 | 30 | 60 | 90 };
const IST = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-05T09:00:00Z'); // 14:30 IST on 2026-10-05
const task = (over: Partial<EngineTask> & { id: string }): EngineTask => ({ title: `Task ${over.id}`, completed: false, priority: 'medium', ...over });
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const types = (tasks: EngineTask[], prefs = ALL, now = NOW, zone = IST) => computeReminderEvents(tasks, prefs, zone, now).map((e) => `${e.type}:${e.task.id}`);

describe('deadlines and days', () => {
  it('dueDayKey is the UTC date part of the stored due date; unusable values are null', () => {
    expect(dueDayKey(day('2026-10-05'))).toBe('2026-10-05');
    expect(dueDayKey('2026-10-05T00:00:00.000Z')).toBe('2026-10-05');
    expect(dueDayKey(null)).toBeNull();
    expect(dueDayKey(undefined)).toBeNull();
    expect(dueDayKey('banana')).toBeNull();
    expect(dueDayKey(new Date('invalid'))).toBeNull();
  });
  it('exactDeadline needs a valid dueTime; a date-only or malformed one has none', () => {
    expect(exactDeadline({ dueDate: day('2026-10-05'), dueTime: '15:00' }, IST)).toBe(Date.parse('2026-10-05T09:30:00Z'));
    expect(exactDeadline({ dueDate: day('2026-10-05') }, IST)).toBeNull();
    expect(exactDeadline({ dueDate: day('2026-10-05'), dueTime: '25:00' }, IST)).toBeNull();
    expect(exactDeadline({ dueDate: day('2026-10-05'), dueTime: '9:00' }, IST)).toBeNull();
    expect(exactDeadline({ dueTime: '15:00' }, IST)).toBeNull();
  });
  it('the same dueTime is a different instant in a different zone', () => {
    const t = { dueDate: day('2026-10-05'), dueTime: '15:00' };
    expect(exactDeadline(t, 'UTC')).toBe(Date.parse('2026-10-05T15:00:00Z'));
    expect(exactDeadline(t, 'America/Los_Angeles')).toBe(Date.parse('2026-10-05T22:00:00Z'));
  });
});

describe('overdue email window (server-only bound)', () => {
  it('is sent for 24 hours after the deadline, then never', () => {
    const t = task({ id: 'a', dueDate: day('2026-10-04'), dueTime: '14:30' }); // deadline 2026-10-04T09:00Z
    const deadline = Date.parse('2026-10-04T09:00:00Z');
    expect(types([t], ALL, deadline + OVERDUE_EMAIL_WINDOW_MS)).toEqual(['overdue:a']); // inclusive
    expect(types([t], ALL, deadline + OVERDUE_EMAIL_WINDOW_MS + 1)).toEqual([]);
  });
  it('turning email on does not mail old overdue tasks', () => {
    const old = [1, 2, 3].map((n) => task({ id: `o${n}`, dueDate: day('2026-09-01'), dueTime: '10:00' }));
    expect(types(old)).toEqual([]);
  });
});

describe('preferences change which events exist', () => {
  const tasks = [
    task({ id: 'soon', dueDate: day('2026-10-05'), dueTime: '15:00' }),
    task({ id: 'late', dueDate: day('2026-10-05'), dueTime: '14:00' }),
    task({ id: 'day', dueDate: day('2026-10-05') }),
    task({ id: 'start', startTime: '2026-10-05T09:30:00Z' }),
    task({ id: 'go', startTime: '2026-10-05T08:59:00Z' }),
  ];
  it('all on', () => {
    expect(types(tasks).sort()).toEqual(['due-soon:day', 'due-soon:soon', 'overdue:late', 'start-now:go', 'work-session-soon:start']);
  });
  it('dueSoonEnabled gates exact and date-only due-soon', () => {
    expect(types(tasks, { ...ALL, dueSoonEnabled: false }).some((e) => e.startsWith('due-soon'))).toBe(false);
  });
  it('overdueEnabled gates overdue', () => {
    expect(types(tasks, { ...ALL, overdueEnabled: false }).some((e) => e.startsWith('overdue'))).toBe(false);
  });
  it('workSessionSoonEnabled and startNowEnabled gate the start window independently', () => {
    expect(types(tasks, { ...ALL, workSessionSoonEnabled: false }).some((e) => e.startsWith('work-session'))).toBe(false);
    expect(types(tasks, { ...ALL, workSessionSoonEnabled: false })).toContain('start-now:go');
    expect(types(tasks, { ...ALL, startNowEnabled: false }).some((e) => e.startsWith('start-now'))).toBe(false);
    expect(types(tasks, { ...ALL, startNowEnabled: false })).toContain('work-session-soon:start');
  });
  it('bufferMinutes moves the heads-up window', () => {
    const t = [task({ id: 'b', startTime: '2026-10-05T10:15:00Z' })]; // 75 minutes from now
    expect(types(t, { ...ALL, bufferMinutes: 60 })).toEqual([]);
    expect(types(t, { ...ALL, bufferMinutes: 90 })).toEqual(['work-session-soon:b']);
    expect(types(t, { ...ALL, bufferMinutes: 15 })).toEqual([]);
  });
});

describe('event keys: the durable identity', () => {
  const keyOf = (t: EngineTask, now = NOW, zone = IST) => computeReminderEvents([t], ALL, zone, now).map((e) => e.key);

  it('the same task at a later poll in the same window has the SAME key (replay, retry and restart cannot re-arm it)', () => {
    const t = task({ id: 'a', dueDate: day('2026-10-05'), dueTime: '15:00' });
    expect(keyOf(t, NOW)).toEqual(keyOf(t, NOW + 5 * 60_000));
    expect(keyOf(t, NOW)).toHaveLength(1);
  });
  it('editing the title, priority or an unrelated field does not change the key', () => {
    const a = task({ id: 'a', dueDate: day('2026-10-05'), dueTime: '15:00' });
    expect(keyOf({ ...a, title: 'Renamed', priority: 'high', estimatedMinutes: 0 })).toEqual(keyOf(a));
  });
  it('changing the due time, due date, start time or zone is a new schedule', () => {
    const a = task({ id: 'a', dueDate: day('2026-10-05'), dueTime: '15:00' });
    expect(keyOf({ ...a, dueTime: '15:10' })).not.toEqual(keyOf(a));
    expect(keyOf({ ...a, startTime: '2026-10-05T08:00:00Z' }).filter((k) => k.includes('due-soon'))).not.toEqual(keyOf(a));
  });
  it('types and tasks never share a key; date-only keys carry the day only (no zone)', () => {
    const events = computeReminderEvents(
      [task({ id: 'a', dueDate: day('2026-10-05') }), task({ id: 'b', dueDate: day('2026-10-04') }), task({ id: 'c', dueDate: day('2026-10-05'), dueTime: '15:00' })],
      ALL,
      IST,
      NOW,
    );
    expect(new Set(events.map((e) => e.key)).size).toBe(events.length);
    expect(events.find((e) => e.task.id === 'a')!.key).toBe('day:due-soon:a:2026-10-05');
    expect(events.find((e) => e.task.id === 'b')!.key).toBe('day:overdue:b:2026-10-04');
    expect(events.find((e) => e.task.id === 'c')!.key).toBe('task:due-soon:c:2026-10-05:t15:00@Asia/Kolkata');
  });
  it('a date-only key is identical in another zone (a zone change cannot repeat the reminder)', () => {
    const t = task({ id: 'a', dueDate: day('2026-10-05') });
    expect(keyOf(t, Date.parse('2026-10-05T09:00:00Z'), 'Asia/Kolkata')).toEqual(keyOf(t, Date.parse('2026-10-05T09:00:00Z'), 'UTC'));
  });
});

describe('determinism', () => {
  it('events come out in a fixed order whatever the input order', () => {
    const tasks = ['d', 'b', 'a', 'c'].map((id) => task({ id, dueDate: day('2026-10-05') }));
    expect(types(tasks)).toEqual(['due-soon:a', 'due-soon:b', 'due-soon:c', 'due-soon:d']);
    expect(types([...tasks].reverse())).toEqual(types(tasks));
  });
});

// ── Daily digest ───────────────────────────────────────────────────────────────────────────────────────────────────

describe('computeDigest', () => {
  const ON = { digestEnabled: true, digestTime: '07:30' };
  const AT = (iso: string) => Date.parse(iso); // 07:30 IST = 02:00Z
  const MORNING = AT('2026-10-05T02:00:00Z'); // 07:30 IST on 2026-10-05

  const tasks = [
    task({ id: 'old', title: 'Old one', dueDate: day('2026-10-01') }),
    task({ id: 'ytd', title: 'Yesterday', dueDate: day('2026-10-04'), dueTime: '17:00' }),
    task({ id: 'low', title: 'Low today', dueDate: day('2026-10-05'), priority: 'low' }),
    task({ id: 'hi', title: 'High today', dueDate: day('2026-10-05'), dueTime: '18:00', priority: 'high' }),
    task({ id: 'med', title: 'Med today', dueDate: day('2026-10-05'), dueTime: '09:00', priority: 'medium' }),
    task({ id: 'tom', title: 'Tomorrow', dueDate: day('2026-10-06') }),
    task({ id: 'd3', title: 'In three days', dueDate: day('2026-10-08') }),
    task({ id: 'd4', title: 'In four days', dueDate: day('2026-10-09') }),
    task({ id: 'done', title: 'Done', dueDate: day('2026-10-05'), completed: true }),
    task({ id: 'none', title: 'No date' }),
  ];

  it('is null when the digest is off, before its time, or there is nothing to say', () => {
    expect(computeDigest(tasks, { digestEnabled: false, digestTime: '07:30' }, IST, MORNING)).toBeNull();
    expect(computeDigest(tasks, ON, IST, MORNING - 60_000)).toBeNull(); // 07:29
    expect(computeDigest([task({ id: 'x' }), task({ id: 'y', dueDate: day('2026-12-25') })], ON, IST, MORNING)).toBeNull();
    expect(computeDigest([], ON, IST, MORNING)).toBeNull();
  });

  it('is eligible from its time to the end of the local day (a late run still sends it)', () => {
    expect(computeDigest(tasks, ON, IST, MORNING)).not.toBeNull(); // 07:30 inclusive
    expect(computeDigest(tasks, ON, IST, AT('2026-10-05T18:29:00Z'))).not.toBeNull(); // 23:59 IST
    expect(computeDigest(tasks, ON, IST, AT('2026-10-05T18:29:00Z'))!.key).toBe('digest:2026-10-05');
  });

  it('sections: overdue (oldest first), today (priority then time, done excluded), upcoming (next 3 days, not 4)', () => {
    const digest = computeDigest(tasks, ON, IST, MORNING)!;
    expect(digest.overdue.tasks.map((t) => t.id)).toEqual(['old', 'ytd']);
    expect(digest.today.tasks.map((t) => t.id)).toEqual(['hi', 'med', 'low']);
    expect(digest.upcoming.tasks.map((t) => t.id)).toEqual(['tom', 'd3']);
    expect([digest.overdue.more, digest.today.more, digest.upcoming.more]).toEqual([0, 0, 0]);
  });

  it('a timed task due earlier today that has passed is overdue, not "today"', () => {
    const afternoon = AT('2026-10-05T09:00:00Z'); // 14:30 IST; "med" was due 09:00 IST
    const digest = computeDigest(tasks, ON, IST, afternoon)!;
    expect(digest.overdue.tasks.map((t) => t.id)).toContain('med');
    expect(digest.today.tasks.map((t) => t.id)).toEqual(['hi', 'low']);
  });

  it('is deterministic: input order is irrelevant, ties break on title then id', () => {
    const tie = ['c', 'a', 'b'].map((id) => task({ id, title: 'Same', dueDate: day('2026-10-05') }));
    const a = computeDigest(tie, ON, IST, MORNING)!;
    const b = computeDigest([...tie].reverse(), ON, IST, MORNING)!;
    expect(a).toEqual(b);
    expect(a.today.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
  });

  it('is bounded: each section lists at most the cap and counts the rest', () => {
    const many = Array.from({ length: 37 }, (_, n) => task({ id: `m${String(n).padStart(2, '0')}`, dueDate: day('2026-10-05') }));
    const digest = computeDigest(many, ON, IST, MORNING)!;
    expect(digest.today.tasks).toHaveLength(DIGEST_SECTION_CAP);
    expect(digest.today.more).toBe(37 - DIGEST_SECTION_CAP);
  });

  it('"today" is the user\'s local day: the same instant is a different digest day in another zone', () => {
    const instant = AT('2026-10-05T20:00:00Z'); // 01:30 Oct 6 IST, 13:00 Oct 5 in Los Angeles
    expect(computeDigest(tasks, { digestEnabled: true, digestTime: '00:00' }, IST, instant)!.key).toBe('digest:2026-10-06');
    expect(computeDigest(tasks, { digestEnabled: true, digestTime: '00:00' }, 'America/Los_Angeles', instant)!.key).toBe('digest:2026-10-05');
  });

  it('one key per local day: two polls on the same day give the same key', () => {
    expect(computeDigest(tasks, ON, IST, MORNING)!.key).toBe(computeDigest(tasks, ON, IST, MORNING + 3 * 3600_000)!.key);
  });
});
