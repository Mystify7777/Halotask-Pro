import mongoose from 'mongoose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import User from '../src/models/User.model';
import { awardTaskCompletion, TreeAwardError } from '../src/utils/treeAward';
import { ACTIVE_DAYS_MAX, XP_PER_COMPLETION } from '../src/utils/treeRules';

// Issue #16 — the atomic award against a REAL MongoDB (MongoMemoryServer), through the real Mongoose model.
// The in-memory doubles prove the logic; this file proves the server really matches `$type: 'array'`, the
// top-level `$or`, and the array-index path `activeDays.19999 $exists:false`, that Mongoose casts the filters
// and updates unchanged, and that concurrent writers keep the ledger, xp and history consistent.

let mongoServer: MongoMemoryServer;
const NOW = new Date('2026-10-06T10:00:00.000Z');
const TODAY = '2026-10-06';
const task = (n: number) => `507f1f77bcf86cd7994${String(n).padStart(5, '0')}`;

const dayN = (n: number) => new Date(Date.UTC(1950, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);

type Raw = { treeState?: Record<string, unknown> };

/** Create a user, then write `treeState` raw (bypassing the schema) so malformed shapes can be seeded. */
const seed = async (treeState: Record<string, unknown>) => {
  const user = await User.create({ name: 'T', email: `t${Math.random().toString(36).slice(2)}@mail.com`, passwordHash: 'x' });
  await User.collection.updateOne({ _id: user._id }, { $set: { treeState } });
  return String(user._id);
};
const raw = async (id: string) => (await User.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })) as Raw | null;
const rawTree = async (id: string) => (await raw(id))!.treeState as Record<string, unknown>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
beforeEach(async () => {
  await User.deleteMany({});
});

describe('real MongoDB: atomic award and history cap', () => {
  it('awards once and writes xp, ledger and today in one document update', async () => {
    const id = await seed({ xp: 0, streakDays: 0, lastActiveDate: null, awardedTaskIds: [], activeDays: [] });
    const result = await awardTaskCompletion(id, task(1), NOW);
    expect(result.awarded).toBe(true);
    const tree = await rawTree(id);
    expect(tree.xp).toBe(XP_PER_COMPLETION);
    expect(tree.awardedTaskIds).toEqual([task(1)]);
    expect(tree.activeDays).toEqual([TODAY]);
    expect(tree.streakDays).toBe(1);
    expect(tree.lastActiveDate).toBe(TODAY);
  });

  it('10 concurrent awards of the SAME task: exactly one wins, xp is granted once', async () => {
    const id = await seed({ xp: 0, streakDays: 0, lastActiveDate: null, awardedTaskIds: [], activeDays: [] });
    const results = await Promise.all(Array.from({ length: 10 }, () => awardTaskCompletion(id, task(1), NOW)));
    expect(results.filter((r) => r.awarded)).toHaveLength(1);
    expect(results.filter((r) => !r.awarded).every((r) => r.reason === 'already_awarded')).toBe(true);
    const tree = await rawTree(id);
    expect(tree.xp).toBe(XP_PER_COMPLETION);
    expect(tree.awardedTaskIds).toEqual([task(1)]);
    expect(tree.activeDays).toEqual([TODAY]);
  });

  it('history at the cap: a new day is refused (history_full), a held day and a re-award of nothing still behave', async () => {
    const days = Array.from({ length: ACTIVE_DAYS_MAX }, (_, i) => dayN(i)); // far in the past, none is today
    const id = await seed({ xp: 50, streakDays: 1, lastActiveDate: days[days.length - 1], awardedTaskIds: [], activeDays: days });
    const before = JSON.stringify(await raw(id));
    const refused = await awardTaskCompletion(id, task(1), NOW);
    expect(refused.awarded).toBe(false);
    expect(refused.reason).toBe('history_full');
    expect(JSON.stringify(await raw(id))).toBe(before);

    // Today already held at the cap: accepted, and the history does not grow.
    const held = [...days.slice(1), TODAY];
    const id2 = await seed({ xp: 50, streakDays: 1, lastActiveDate: TODAY, awardedTaskIds: [], activeDays: held });
    const ok = await awardTaskCompletion(id2, task(2), NOW);
    expect(ok.awarded).toBe(true);
    const tree2 = await rawTree(id2);
    expect((tree2.activeDays as string[]).length).toBe(ACTIVE_DAYS_MAX);
    expect(tree2.xp).toBe(50 + XP_PER_COMPLETION);
  });

  it('history one below the cap accepts the last slot, then refuses the next new day', async () => {
    const days = Array.from({ length: ACTIVE_DAYS_MAX - 1 }, (_, i) => dayN(i));
    const id = await seed({ xp: 0, streakDays: 1, lastActiveDate: days[days.length - 1], awardedTaskIds: [], activeDays: days });
    expect((await awardTaskCompletion(id, task(1), NOW)).awarded).toBe(true);
    expect(((await rawTree(id)).activeDays as string[]).length).toBe(ACTIVE_DAYS_MAX);
    const next = await awardTaskCompletion(id, task(2), new Date('2026-10-07T10:00:00.000Z'));
    expect(next.awarded).toBe(false);
    expect(next.reason).toBe('history_full');
    expect(((await rawTree(id)).awardedTaskIds as string[])).toEqual([task(1)]);
  });
});

describe('real MongoDB: malformed canonical history is a conflict, never rewritten', () => {
  const cases: Array<[string, unknown]> = [
    ['a string', '2026-10-05'],
    ['an object', { 0: '2026-10-05' }],
    ['a number', 7],
    ['duplicates', ['2026-10-04', '2026-10-04', '2026-10-05']],
    ['an invalid date', ['2026-10-04', '2026-13-45']],
    ['a non-string entry', ['2026-10-04', 20261005]],
    ['over the cap', Array.from({ length: ACTIVE_DAYS_MAX + 1 }, (_, i) => dayN(i))],
  ];
  it.each(cases)('rejects with conflict and leaves the document byte-identical: %s', async (_name, activeDays) => {
    const id = await seed({ xp: 40, streakDays: 2, lastActiveDate: '2026-10-05', awardedTaskIds: ['x'], activeDays });
    const before = JSON.stringify(await raw(id));
    await expect(awardTaskCompletion(id, task(1), NOW)).rejects.toMatchObject({ kind: 'conflict' });
    await expect(awardTaskCompletion(id, 'x', NOW)).rejects.toBeInstanceOf(TreeAwardError); // even a retry of an awarded task
    expect(JSON.stringify(await raw(id))).toBe(before);
  });
});

describe('real MongoDB: legacy adoption', () => {
  const legacy = (over: Record<string, unknown> = {}) => ({
    xp: 30, streakDays: 3, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'], ...over,
  });

  it('12 concurrent awards on a legacy tree: one adoption, exact xp/ledger/history, marker removed', async () => {
    const id = await seed(legacy({ pendingDerivedDays: ['2026-10-02'] }));
    const ids = Array.from({ length: 12 }, (_, i) => task(i + 1));
    const settled = await Promise.allSettled(ids.map((t) => awardTaskCompletion(id, t, NOW)));
    const tree = await rawTree(id);
    const ledger = tree.awardedTaskIds as string[];
    const newly = ledger.filter((t) => t !== 'old');
    // every task that reached the ledger has its xp, nothing more; fulfilled awards are all in the ledger
    expect(tree.xp).toBe(30 + XP_PER_COMPLETION * newly.length);
    expect(new Set(ledger).size).toBe(ledger.length);
    for (const [i, s] of settled.entries()) {
      if (s.status === 'fulfilled' && s.value.awarded) expect(ledger).toContain(ids[i]);
      if (s.status === 'rejected') expect((s.reason as TreeAwardError).kind).toMatch(/conflict|derived_unpersisted/);
    }
    expect(newly.length).toBeGreaterThan(0);
    // history: implied streak days 10-03..10-05, the marker day, and today — exactly once each
    expect(tree.activeDays).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', TODAY]);
    expect('pendingDerivedDays' in tree).toBe(false);
    // a quiet follow-up converges the derived copy to the fold of the history
    await awardTaskCompletion(id, task(99), NOW);
    const done = await rawTree(id);
    expect(done.activeDays).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', TODAY]);
    expect(done.lastActiveDate).toBe(TODAY);
    expect(done.streakDays).toBe(5);
  });

  it('refuses without touching the record when the adopted set cannot fit', async () => {
    const pending = Array.from({ length: ACTIVE_DAYS_MAX }, (_, i) => dayN(i)); // + implied days + today > cap
    const id = await seed(legacy({ pendingDerivedDays: pending }));
    const before = JSON.stringify(await raw(id));
    const result = await awardTaskCompletion(id, task(1), NOW);
    expect(result.awarded).toBe(false);
    expect(result.reason).toBe('history_full');
    expect(JSON.stringify(await raw(id))).toBe(before);
  });

  it.each([
    ['zero streak', { streakDays: 0, lastActiveDate: '2026-10-05' }, 1],
    ['missing last-active date', { streakDays: 5, lastActiveDate: undefined }, 1],
    ['invalid last-active date', { streakDays: 5, lastActiveDate: 'garbage' }, 1],
    ['null last-active date', { streakDays: 5, lastActiveDate: null }, 1],
    ['last-active date far in the future', { streakDays: 5, lastActiveDate: '2027-01-01' }, 1],
  ])('does not fabricate a streak: %s', async (_n, over, expectedStreak) => {
    const id = await seed(legacy(over));
    const result = await awardTaskCompletion(id, task(1), NOW);
    expect(result.awarded).toBe(true);
    const tree = await rawTree(id);
    expect(tree.activeDays).toEqual([TODAY]);
    expect(tree.streakDays).toBe(expectedStreak);
  });
});
