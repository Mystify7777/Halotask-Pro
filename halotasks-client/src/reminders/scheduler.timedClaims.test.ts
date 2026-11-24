import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';
import type { Task } from '../types/task';
import { getDeadlineMs, OVERDUE_NOTIFICATION_WINDOW_MS } from './deadlineLogic';
import { createReminderScheduler } from './scheduler';
import { defaultReminderSettings } from './settings';

// Issue #69: a timed reminder is delivered by at most one tab of a browser. The tabs here are separate schedulers over ONE
// shared localStorage (as real same-origin tabs have) and a sessionStorage that is emptied for every new "tab" (as real
// tabs have). Locks are a minimal exclusive Web Locks, or absent (the jsdom default, the documented fallback).

const NOW = new Date(2026, 9, 20, 12, 0, 0); // local noon: outside the default quiet hours
const at = (m: number) => vi.setSystemTime(new Date(NOW.getTime() + m * 60_000));
const dayOf = (m: number) => {
  const d = new Date(NOW.getTime() + m * 60_000);
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())).toISOString();
};
const hm = (m: number) => {
  const d = new Date(NOW.getTime() + m * 60_000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const due = (m: number) => ({ dueDate: dayOf(m), dueTime: hm(m) });
const CLAIMS_KEY = 'halotask_timed_claims';
const claims = () => JSON.parse(localStorage.getItem(CLAIMS_KEY) ?? '{}') as Record<string, { at: number; until: number }>;
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

type Sent = { id: string; type: string; merged?: string[] };

const tab = (tasks: Task[], deliver?: (event: { task: Task }) => unknown) => {
  sessionStorage.clear(); // a new tab starts with an empty sessionStorage
  const sent: Sent[] = [];
  const scheduler = createReminderScheduler({
    getTasks: () => tasks,
    getSettings: () => ({ ...defaultReminderSettings, bufferMinutes: 30 }),
    onReminder: (event) => {
      sent.push({ id: event.task._id, type: event.type, merged: event.merged }); // recorded even if the delivery then throws
      return deliver?.(event);
    },
  });
  return { scheduler, sent };
};

/** A minimal exclusive Web Locks: requests run one at a time, in order. */
const installLocks = () => {
  let tail: Promise<unknown> = Promise.resolve();
  const state = { holding: false, names: [] as string[] };
  const request = vi.fn((name: string, callback: () => unknown) => {
    state.names.push(name);
    const run = tail.then(async () => {
      state.holding = true;
      try {
        return await callback();
      } finally {
        state.holding = false;
      }
    });
    tail = run.catch(() => undefined);
    return run;
  });
  Object.defineProperty(navigator, 'locks', { value: { request }, configurable: true });
  return { request, state };
};

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  vi.useFakeTimers();
  at(0);
});
afterEach(() => {
  Reflect.deleteProperty(navigator, 'locks');
  vi.restoreAllMocks();
  vi.useRealTimers();
  sessionStorage.clear();
  localStorage.clear();
});

describe('two tabs, one reminder', () => {
  it('without Web Locks, a later poll observes the persisted claim (sequential: this is NOT a race test, the race is the documented gap)', () => {
    expect('locks' in navigator).toBe(false); // jsdom: the fallback path
    const task = makeTask({ _id: 'a', ...due(20) });
    const a = tab([task]);
    const b = tab([task]);
    a.scheduler.runNow();
    b.scheduler.runNow();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toEqual([]);
  });

  it('with Web Locks, two tabs polling in the same instant send one reminder between them, claimed before it is sent', async () => {
    const { request, state } = installLocks();
    const task = makeTask({ _id: 'a', ...due(20) });
    const seen: Array<{ held: boolean; claimed: boolean }> = [];
    const deliver = () => seen.push({ held: state.holding, claimed: Object.keys(claims()).length === 1 });
    const a = tab([task], deliver);
    const b = tab([task], deliver);

    a.scheduler.runNow();
    b.scheduler.runNow();
    expect(a.sent.length + b.sent.length).toBe(0); // both queued on the lock
    await flush();

    expect(a.sent).toHaveLength(1);
    expect(b.sent).toEqual([]);
    expect(seen).toEqual([{ held: true, claimed: true }]); // delivered under the lock, with the claim already durable
    expect(request).toHaveBeenCalledWith('halotask-timed-reminders', expect.any(Function));
    expect(state.names.every((name) => name === 'halotask-timed-reminders')).toBe(true); // never the day-reminder lock
  });

  it('a tab built BEFORE the other one claimed is still suppressed: the shared store decides, not a construction-time snapshot', () => {
    const task = makeTask({ _id: 'a', ...due(20) });
    const early = tab([task]); // its fired set was read (empty) now
    const other = tab([task]);
    other.scheduler.runNow();
    early.scheduler.runNow();
    expect(other.sent).toHaveLength(1);
    expect(early.sent).toEqual([]);
  });

  it('two polls of one tab queued on the lock send once', async () => {
    installLocks();
    const a = tab([makeTask({ _id: 'a', ...due(20) })]);
    a.scheduler.runNow();
    a.scheduler.runNow();
    await flush();
    expect(a.sent).toHaveLength(1);
  });

  it('different tasks are independent: each is claimed once, by whichever tab gets there first', () => {
    const tasks = [makeTask({ _id: 'a', ...due(20) }), makeTask({ _id: 'b', ...due(30) })];
    const a = tab([tasks[0]]);
    const b = tab(tasks);
    a.scheduler.runNow();
    b.scheduler.runNow();
    expect([...a.sent, ...b.sent].map((s) => s.id).sort()).toEqual(['a', 'b']);
    expect(b.sent.map((s) => s.id)).toEqual(['b']);
  });
});

describe('lifetime: one claim per reminder window, not once-ever (D3)', () => {
  it('a reload, or a new tab, inside the window does not announce it again', () => {
    const task = makeTask({ _id: 'a', ...due(20) });
    const first = tab([task]);
    first.scheduler.runNow();
    at(5);
    const reloaded = tab([task]); // empty sessionStorage, as after a reload
    reloaded.scheduler.runNow();
    expect(first.sent).toHaveLength(1);
    expect(reloaded.sent).toEqual([]);
  });

  it('a reschedule is a new reminder: moving the due time sends again', () => {
    const task = makeTask({ _id: 'a', ...due(20) });
    const a = tab([task]);
    a.scheduler.runNow();
    const b = tab([{ ...task, ...due(40) }]);
    b.scheduler.runNow();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it('the claim records its window: due-soon until the deadline, overdue until the deadline plus the 24 h bound', () => {
    const soon = makeTask({ _id: 'soon', ...due(20) });
    const late = makeTask({ _id: 'late', ...due(-30) });
    tab([soon, late]).scheduler.runNow();
    const stored = claims();
    const byType = (type: string) => Object.entries(stored).find(([key]) => key.startsWith(`${type}:`))![1];
    expect(byType('due-soon').until).toBe(getDeadlineMs(soon));
    expect(byType('overdue').until).toBe((getDeadlineMs(late) as number) + OVERDUE_NOTIFICATION_WINDOW_MS);
    expect(byType('due-soon').at).toBe(NOW.getTime());
  });

  it('start reminders last until the end of their start window', () => {
    const task = makeTask({ _id: 'a', startTime: new Date(NOW.getTime() + 10 * 60_000).toISOString() });
    tab([task]).scheduler.runNow(); // heads-up window: start in 10 min, buffer 30
    const [entry] = Object.values(claims());
    expect(entry.until).toBe(NOW.getTime() + 10 * 60_000 + 30 * 60_000); // explicit start + buffer: no due time
  });

  it('an expired claim is not a claim: the record is ignored and pruned on the next write', () => {
    const task = makeTask({ _id: 'a', ...due(20) });
    const other = makeTask({ _id: 'z', ...due(25) });
    tab([task]).scheduler.runNow();
    const stale = Object.keys(claims())[0];
    const record = claims();
    record[stale].until = NOW.getTime() - 1; // expired by its own record
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(record));

    const again = tab([task, other]);
    again.scheduler.runNow();
    expect(again.sent.map((s) => s.id).sort()).toEqual(['a', 'z']); // expired claim does not suppress
    expect(Object.keys(claims()).sort()).toHaveLength(2); // and the expired record was replaced, not accumulated
  });
});

describe('failed delivery keeps the claim (D5)', () => {
  it.each([
    ['throws', () => { throw new Error('boom'); }],
    ['returns false', () => false],
  ])('a delivery that %s is not retried by this tab or taken over by another', (_name, deliver) => {
    const task = makeTask({ _id: 'a', ...due(20) });
    const a = tab([task], deliver);
    expect(() => a.scheduler.runNow()).not.toThrow();
    a.scheduler.runNow();
    const b = tab([task]);
    b.scheduler.runNow();
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toEqual([]);
  });

  it('one task throwing does not stop the other reminders of the poll', () => {
    const tasks = [makeTask({ _id: 'bad', ...due(20) }), makeTask({ _id: 'good', ...due(25) })];
    const a = tab(tasks, ({ task }) => {
      if (task._id === 'bad') throw new Error('boom');
    });
    a.scheduler.runNow();
    expect(a.sent.map((s) => s.id)).toEqual(['bad', 'good']);
  });
});

describe('merged groups send only what is unclaimed (D7)', () => {
  it('a task due in 45 min with a 30 min estimate has due-soon and the heads-up open together: one claim of both', () => {
    const task = makeTask({ _id: 'c', ...due(45), estimatedMinutes: 30 });
    const a = tab([task]);
    a.scheduler.runNow();
    expect(a.sent).toEqual([{ id: 'c', type: 'due-soon', merged: ['due-soon', 'work-session-soon'] }]);
    expect(Object.keys(claims())).toHaveLength(2);
  });

  it('when another tab already claimed one of the group, only the rest is sent, led by the first remaining type', () => {
    const task = makeTask({ _id: 'c', ...due(45), estimatedMinutes: 30 });
    const first = tab([task]);
    first.scheduler.runNow();
    const record = claims();
    const dueSoonKey = Object.keys(record).find((key) => key.startsWith('due-soon:'))!;
    delete record[dueSoonKey]; // only the heads-up was claimed by the other tab
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(record));

    const second = tab([task]);
    second.scheduler.runNow();
    expect(second.sent).toEqual([{ id: 'c', type: 'due-soon', merged: ['due-soon'] }]);
  });

  it('when everything in the group was claimed, nothing is sent', () => {
    const task = makeTask({ _id: 'c', ...due(45), estimatedMinutes: 30 });
    tab([task]).scheduler.runNow();
    const second = tab([task]);
    second.scheduler.runNow();
    expect(second.sent).toEqual([]);
  });
});

describe('storage that is missing, malformed or hostile (D9)', () => {
  const task = () => makeTask({ _id: 'a', ...due(20) });

  it.each([
    ['not JSON', '{nope'],
    ['an array', '[1,2,3]'],
    ['null', 'null'],
    ['entries of the wrong shape', JSON.stringify({ x: 5, y: { at: 'a', until: 'b' }, z: null })],
  ])('%s: delivery still happens, and the record is rewritten valid', (_name, raw) => {
    localStorage.setItem(CLAIMS_KEY, raw);
    const a = tab([task()]);
    a.scheduler.runNow();
    expect(a.sent).toHaveLength(1);
    const stored = claims();
    expect(Object.keys(stored)).toHaveLength(1);
    expect(Object.values(stored)[0].until).toBeGreaterThan(NOW.getTime());
  });

  it('a claim that claims to last longer than any real window is not trusted (clock skew or tampering)', () => {
    const probe = tab([task()]);
    probe.scheduler.runNow();
    const key = Object.keys(claims())[0];
    localStorage.setItem(CLAIMS_KEY, JSON.stringify({ [key]: { at: NOW.getTime(), until: NOW.getTime() + 10 * 24 * 60 * 60 * 1000 } }));
    const next = tab([task()]);
    next.scheduler.runNow();
    expect(next.sent).toHaveLength(1);
  });

  it('localStorage that throws on read and write: the tab still delivers, once, from its own fired set', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === CLAIMS_KEY) throw new Error('denied');
      return null;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === CLAIMS_KEY) throw new Error('quota');
    });
    const a = tab([task()]);
    expect(() => a.scheduler.runNow()).not.toThrow();
    a.scheduler.runNow();
    expect(a.sent).toHaveLength(1);
  });

  it('with unusable storage, two polls of one tab queued on the lock still send once (the tab\'s own fired set is re-checked inside the lock)', async () => {
    installLocks();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation((key) => {
      if (key === CLAIMS_KEY) throw new Error('denied');
      return null;
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation((key) => {
      if (key === CLAIMS_KEY) throw new Error('quota');
    });
    const a = tab([task()]);
    a.scheduler.runNow();
    a.scheduler.runNow();
    await flush();
    expect(a.sent).toHaveLength(1);
  });

  it.each([
    ['claimed in the future', (now: number) => ({ at: now + 10 * 24 * 60 * 60 * 1000, until: now + 24 * 60 * 60 * 1000 })],
    ['claimed after it ends', (now: number) => ({ at: now - 1000, until: now - 2000 })],
    ['a negative claim time', (now: number) => ({ at: -5, until: now + 60_000 })],
    ['claimed a moment ahead of the clock', (now: number) => ({ at: now + 1, until: now + 60_000 })],
  ])('an incoherent record (%s) is not a claim', (_name, build) => {
    const probe = tab([task()]);
    probe.scheduler.runNow();
    const key = Object.keys(claims())[0];
    localStorage.setItem(CLAIMS_KEY, JSON.stringify({ [key]: build(NOW.getTime()) }));
    const next = tab([task()]);
    next.scheduler.runNow();
    expect(next.sent).toHaveLength(1);
    expect(claims()[key].at).toBe(NOW.getTime()); // replaced by a coherent record
  });

  it('a coherent record is honoured (claimed in the past, still in force)', () => {
    const probe = tab([task()]);
    probe.scheduler.runNow();
    const key = Object.keys(claims())[0];
    localStorage.setItem(CLAIMS_KEY, JSON.stringify({ [key]: { at: NOW.getTime() - 60_000, until: NOW.getTime() + 60_000 } }));
    const next = tab([task()]);
    next.scheduler.runNow();
    expect(next.sent).toEqual([]);
  });

  it('only live claims count toward the cap: expired records are dropped first, so they never push out a live one', () => {
    const seeded: Record<string, { at: number; until: number }> = {};
    for (let i = 0; i < 400; i += 1) seeded[`expired-${i}`] = { at: NOW.getTime() - 5000 + i, until: NOW.getTime() - 1 };
    for (let i = 0; i < 100; i += 1) seeded[`live-${i}`] = { at: NOW.getTime() - 1000 + i, until: NOW.getTime() + 60_000 };
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(seeded));
    tab([task()]).scheduler.runNow();
    const stored = claims();
    expect(Object.keys(stored)).toHaveLength(101); // 100 live + the new one; nothing live was evicted
    expect(Object.keys(stored).some((key) => key.startsWith('expired-'))).toBe(false);
    expect('live-0' in stored).toBe(true);
  });

  it('the store is capped: the oldest claims are dropped past 500 entries', () => {
    const seeded: Record<string, { at: number; until: number }> = {};
    for (let i = 0; i < 520; i += 1) seeded[`old-${i}`] = { at: NOW.getTime() - 1000 + i, until: NOW.getTime() + 60_000 };
    localStorage.setItem(CLAIMS_KEY, JSON.stringify(seeded));
    tab([task()]).scheduler.runNow();
    const stored = claims();
    expect(Object.keys(stored)).toHaveLength(500);
    expect(Object.keys(stored).some((key) => key.startsWith('due-soon:'))).toBe(true); // the new claim is the newest
    expect('old-0' in stored).toBe(false);
  });
});

describe('Web Locks that fail', () => {
  it('a rejected lock request falls back to running the same steps directly (no reminder is lost)', async () => {
    Object.defineProperty(navigator, 'locks', { value: { request: vi.fn(() => Promise.reject(new Error('denied'))) }, configurable: true });
    const a = tab([makeTask({ _id: 'a', ...due(20) })]);
    a.scheduler.runNow();
    await flush();
    expect(a.sent).toHaveLength(1);
  });

  it('a lock request that throws synchronously also falls back', () => {
    Object.defineProperty(navigator, 'locks', {
      value: {
        request: vi.fn(() => {
          throw new Error('unsupported');
        }),
      },
      configurable: true,
    });
    const a = tab([makeTask({ _id: 'a', ...due(20) })]);
    a.scheduler.runNow();
    expect(a.sent).toHaveLength(1);
  });
});
