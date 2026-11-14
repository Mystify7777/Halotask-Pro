import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../offline/history';
import type { HistorySource, ServerHistoryEntry } from '../services/historyService';
import { pointsFromLocal, pointsFromServer } from './dayPoints';
import { addDays } from './trend';

const TODAY = '2026-11-14';

type Spec = { count?: number; source?: HistorySource | null; exists?: boolean };
/** `specs` oldest -> newest ending today. */
const rows = (specs: Spec[], today = TODAY): ServerHistoryEntry[] =>
  specs.map((s, i) => {
    const date = addDays(today, -(specs.length - 1 - i));
    const count = s.count ?? 0;
    const source = s.source === undefined ? (count > 0 ? 'canonical' : 'none') : s.source;
    return {
      source,
      exists: s.exists ?? (source !== 'none'),
      entry: { date, completedCount: count, workDoneMinutes: count * 10, completedTasks: [] },
    };
  });
const none = (n: number): Spec[] => Array.from({ length: n }, () => ({ source: 'none' as const }));
const local = (counts: number[], today = TODAY): HistoryEntry[] =>
  counts.map((c, i) => ({
    date: addDays(today, -(counts.length - 1 - i)),
    completedCount: c,
    workDoneMinutes: c * 10,
    completedTasks: Array.from({ length: c }, (_, k) => ({ id: `t${i}-${k}`, title: 't', estimatedMinutes: 10 })),
  }));

describe('pointsFromServer: the known span', () => {
  it('days from the first evidence onward are known, so a quiet day after history began is a real zero', () => {
    const pts = pointsFromServer(rows([...none(3), { count: 2 }, { source: 'none' }, { count: 1 }]), TODAY, 6)!;
    expect(pts.map((p) => p.known)).toEqual([false, false, false, true, true, true]);
    expect(pts[4]).toMatchObject({ completed: 0, known: true }); // a zero, not a hole
  });

  it('a window with no evidence is entirely unknown (nothing recorded, not "zero completions")', () => {
    const pts = pointsFromServer(rows(none(7)), TODAY, 7)!;
    expect(pts.every((p) => !p.known)).toBe(true);
  });

  it('a legacy snapshot day, even with zero completions, is evidence', () => {
    const pts = pointsFromServer(rows([{ source: 'none' }, { source: 'legacy', count: 0 }, { source: 'none' }]), TODAY, 3)!;
    expect(pts.map((p) => p.known)).toEqual([false, true, true]);
  });

  it('a canonical day whose records are all revoked is an authoritative zero and counts as evidence', () => {
    const pts = pointsFromServer(rows([{ source: 'none' }, { source: 'canonical', count: 0 }, { source: 'none' }]), TODAY, 3)!;
    expect(pts.map((p) => p.known)).toEqual([false, true, true]);
  });

  it('an older server with no `source` key: an existing row is evidence, a placeholder is not', () => {
    const r = rows([{ source: null, exists: false }, { source: null, exists: true, count: 1 }, { source: null, exists: false }]);
    const pts = pointsFromServer(r, TODAY, 3)!;
    expect(pts.map((p) => p.known)).toEqual([false, true, true]);
  });

  it('carries counts and minutes through unchanged', () => {
    const pts = pointsFromServer(rows([{ count: 3 }, { count: 0, source: 'legacy' }]), TODAY, 2)!;
    expect(pts[0]).toMatchObject({ date: '2026-11-13', completed: 3, minutes: 30 });
    expect(pts[1]).toMatchObject({ date: TODAY, completed: 0, minutes: 0 });
  });
});

describe('pointsFromServer: a broken answer is refused, not repaired', () => {
  const good = () => rows(Array.from({ length: 5 }, () => ({ count: 1 })));

  it.each([
    ['too few rows', (r: ServerHistoryEntry[]) => r.slice(1)],
    ['too many rows', (r: ServerHistoryEntry[]) => [r[0], ...r]],
    ['a gap', (r: ServerHistoryEntry[]) => [r[0], r[1], r[3], r[4], r[4]]],
    ['out of order', (r: ServerHistoryEntry[]) => [r[1], r[0], r[2], r[3], r[4]]],
    ['a duplicate day', (r: ServerHistoryEntry[]) => [r[0], r[1], r[1], r[3], r[4]]],
    ['a window that stops a day early (must not throw)', (r: ServerHistoryEntry[]) => r.slice(0, -1)],
    ['an extra day after today', (r: ServerHistoryEntry[]) => [...r, { ...r[4], entry: { ...r[4].entry, date: addDays(TODAY, 1) } }]],
    ['a window that does not end today', (r: ServerHistoryEntry[]) => r.map((x) => ({ ...x, entry: { ...x.entry, date: addDays(x.entry.date, -1) } }))],
  ])('%s', (_n, mutate) => {
    expect(pointsFromServer(mutate(good()), TODAY, 5)).toBeNull();
  });

  it('refuses a row the trend model would refuse (fractional count, negative minutes)', () => {
    const r = good();
    r[2] = { ...r[2], entry: { ...r[2].entry, completedCount: 1.5 } };
    expect(pointsFromServer(r, TODAY, 5)).toBeNull();
    const s = good();
    s[2] = { ...s[2], entry: { ...s[2].entry, workDoneMinutes: -1 } };
    expect(pointsFromServer(s, TODAY, 5)).toBeNull();
  });
});

describe('pointsFromLocal', () => {
  it('the first completion starts the known span; earlier placeholder days are unknown', () => {
    const pts = pointsFromLocal(local([0, 0, 2, 0, 1, 0, 0]), TODAY)!;
    expect(pts.map((p) => p.known)).toEqual([false, false, true, true, true, true, true]);
  });

  it('seven placeholder days with nothing completed are all unknown', () => {
    expect(pointsFromLocal(local([0, 0, 0, 0, 0, 0, 0]), TODAY)!.every((p) => !p.known)).toBe(true);
  });

  it('a day with a listed task counts as evidence even if the count field is zero', () => {
    const e = local([0, 0, 0]);
    e[1].completedTasks = [{ id: 'x', title: 'x', estimatedMinutes: 5 }];
    expect(pointsFromLocal(e, TODAY)!.map((p) => p.known)).toEqual([false, true, true]);
  });

  it('refuses an empty list, a list that does not end today, or one with a gap', () => {
    expect(pointsFromLocal([], TODAY)).toBeNull();
    expect(pointsFromLocal(local([1, 1, 1], '2026-11-13'), TODAY)).toBeNull();
    const gap = local([1, 1, 1]);
    expect(pointsFromLocal([gap[0], gap[2]], TODAY)).toBeNull();
  });
});
