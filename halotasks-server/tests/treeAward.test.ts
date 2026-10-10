import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserStore, taskIdOf, type UserStore } from './helpers/treeDoubles';
import { AWARDED_TASK_IDS_MAX, MAX_XP } from '../src/utils/treeRules';

// Issue #24 — awardTaskCompletion against a strict in-memory User double (atomic match+apply, throws on
// any operator the real code does not use). Nothing here needs a MongoDB; the exact command Mongoose
// sends is pinned separately in treeAward.mongoose.test.ts.

type AwardModule = typeof import('../src/utils/treeAward.js');

const USER = 'user-1';
const NOW = new Date('2026-10-06T10:00:00.000Z');
const DAY = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000);

let users: UserStore;
let award: AwardModule['awardTaskCompletion'];
let TreeAwardError: AwardModule['TreeAwardError'];
let readPersistedGrowth: AwardModule['readPersistedGrowth'];

beforeEach(async () => {
  vi.resetModules();
  users = createUserStore();
  vi.doMock('../src/models/User.model', () => ({ default: users.model }));
  ({ awardTaskCompletion: award, TreeAwardError, readPersistedGrowth } = await import('../src/utils/treeAward.js'));
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.doUnmock('../src/models/User.model');
  vi.restoreAllMocks();
});

// The derived write is the only update that carries $set AND $unset (the award carries $inc/$push).
const isDerivedWrite = (op: { update?: Record<string, unknown> }) => Boolean(op.update?.$unset);
// Counted on `applied` (operations that changed the document), not `ops`: the award attempt that matches
// nothing — a retry of an already-awarded task — is still an entered operation but writes nothing.
const incrementsApplied = () => users.applied.filter((o) => o.update?.$inc).length;
const writesSince = (mark: number) => users.applied.slice(mark);

const fresh = (over: Record<string, unknown> = {}) =>
  ({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed', awardedTaskIds: [], ...over });

describe('the award', () => {
  it('false -> true awards exactly +10 XP, records the id, and starts the streak', async () => {
    users.seed(USER, fresh());

    const result = await award(USER, taskIdOf(1), NOW);

    expect(result).toMatchObject({ taskId: taskIdOf(1), awarded: true, xpGained: 10 });
    expect(result.treeState).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy', stage: 'seed', leaves: 0 });
    expect(result.treeState).not.toHaveProperty('awardedTaskIds');
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)], streakDays: 1, lastCalculatedAt: NOW.toISOString() });
  });

  it('derives leaves and stage from XP on the server', async () => {
    users.seed(USER, fresh({ xp: 190, awardedTaskIds: ['x'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState).toMatchObject({ xp: 200, leaves: 10, stage: 'mature' });
    expect(users.tree(USER)).toMatchObject({ xp: 200, leaves: 10, stage: 'mature' });
  });

  it('a second award for the same task is refused and changes nothing (retry / duplicate)', async () => {
    users.seed(USER, fresh());
    await award(USER, taskIdOf(1), NOW);
    const before = users.tree(USER);

    const again = await award(USER, taskIdOf(1), NOW);

    expect(again).toMatchObject({ awarded: false, xpGained: 0, reason: 'already_awarded' });
    expect(again.treeState.xp).toBe(10);
    expect(users.tree(USER)).toEqual(before);
  });

  it('uncomplete -> re-complete (same task id, later) still yields one award', async () => {
    users.seed(USER, fresh());
    await award(USER, taskIdOf(1), NOW);
    const later = await award(USER, taskIdOf(1), DAY(3));
    expect(later.awarded).toBe(false);
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)], lastActiveDate: '2026-10-06' });
  });

  it('rejects an invalid task id and an unknown user without touching anything', async () => {
    users.seed(USER, fresh());
    await expect(award(USER, '', NOW)).rejects.toMatchObject({ kind: 'invalid_task_id' });
    await expect(award(USER, 'x'.repeat(65), NOW)).rejects.toBeInstanceOf(TreeAwardError);
    await expect(award('nobody', taskIdOf(1), NOW)).rejects.toMatchObject({ kind: 'user_not_found' });
    expect(users.tree(USER)).toMatchObject({ xp: 0, awardedTaskIds: [] });
  });
});

describe('concurrency', () => {
  it('10 simultaneous completions of the SAME task award exactly once', async () => {
    users.seed(USER, fresh());

    const results = await Promise.all(Array.from({ length: 10 }, () => award(USER, taskIdOf(1), NOW)));

    expect(results.filter((r) => r.awarded)).toHaveLength(1);
    expect(results.filter((r) => !r.awarded).every((r) => r.reason === 'already_awarded')).toBe(true);
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)] });
  });

  it('25 simultaneous completions of DIFFERENT tasks keep every point of XP', async () => {
    users.seed(USER, fresh());

    const results = await Promise.all(Array.from({ length: 25 }, (_, i) => award(USER, taskIdOf(i + 1), NOW)));

    expect(results.every((r) => r.awarded)).toBe(true);
    const tree = users.tree(USER) as { xp: number; awardedTaskIds: string[]; streakDays: number };
    expect(tree.xp).toBe(250);
    expect(new Set(tree.awardedTaskIds).size).toBe(25);
    expect(tree.streakDays).toBe(1);
  });

  it('the first awards of a new day (concurrent) advance the streak exactly once', async () => {
    users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));

    await Promise.all(Array.from({ length: 12 }, (_, i) => award(USER, taskIdOf(i + 1), NOW)));

    expect(users.tree(USER)).toMatchObject({ xp: 160, streakDays: 5, lastActiveDate: '2026-10-06', health: 'healthy' });
  });

  it('interleaving a competing write between step 1 and step 2 is not lost', async () => {
    users.seed(USER, fresh());
    let injected = false;
    users.hooks.before = async (op) => {
      // Just before the derived write, another device's award lands.
      if (!injected && op.op === 'findOneAndUpdate' && op.update?.$set) {
        injected = true;
        await users.model.findOneAndUpdate(
          { _id: USER, 'treeState.awardedTaskIds': { $ne: taskIdOf(2) } },
          { $inc: { 'treeState.xp': 10 }, $push: { 'treeState.awardedTaskIds': taskIdOf(2) } },
        );
      }
    };

    const result = await award(USER, taskIdOf(1), NOW);

    expect(result.awarded).toBe(true);
    expect(users.tree(USER)).toMatchObject({ xp: 20, streakDays: 1 });
    expect(result.treeState.xp).toBe(20);
  });
});

describe('streak and health (the existing UTC rule, now server-side)', () => {
  it.each([
    ['no previous activity', 0, null, 1],
    ['same day', 4, '2026-10-06', 4],
    ['yesterday', 4, '2026-10-05', 5],
    ['two days ago', 4, '2026-10-04', 1],
    ['a future date (clock skew / forged)', 4, '2999-01-01', 4],
    ['an unparsable stored date', 4, 'junk', 1],
  ] as const)('%s', async (_label, streakDays, lastActiveDate, expected) => {
    users.seed(USER, fresh({ streakDays, lastActiveDate, xp: 10, awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState.streakDays).toBe(expected);
    expect(result.treeState.lastActiveDate).toBe('2026-10-06');
    expect(result.treeState.health).toBe('healthy');
  });

  it('follows the calendar across consecutive days', async () => {
    users.seed(USER, fresh());
    await award(USER, taskIdOf(1), DAY(0));
    await award(USER, taskIdOf(2), DAY(1));
    await award(USER, taskIdOf(3), DAY(2));
    expect(users.tree(USER)).toMatchObject({ streakDays: 3, xp: 30 });
    await award(USER, taskIdOf(4), DAY(5));
    expect(users.tree(USER)).toMatchObject({ streakDays: 1, xp: 40 });
  });
});

describe('legacy and damaged data', () => {
  it('keeps legitimate XP that has no ledger entries (tasks since deleted): never clamped', async () => {
    users.seed(USER, fresh({ xp: 500, awardedTaskIds: [] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState.xp).toBe(510);
  });

  it('a user with no treeState at all gets one and is awarded', async () => {
    users.seed(USER);
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.awarded).toBe(true);
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)] });
  });

  it.each([
    ['Infinity', Infinity],
    ['NaN', NaN],
    ['negative', -50],
    ['a string', '9999'],
  ])('repairs a stored xp of %s to 0, then awards', async (_label, xp) => {
    users.seed(USER, fresh({ xp }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.awarded).toBe(true);
    expect(users.tree(USER).xp).toBe(10);
  });

  it('floors a fractional stored xp and keeps the integer part', async () => {
    users.seed(USER, fresh({ xp: 12.9 }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState.xp).toBe(22);
    expect(Number.isInteger(users.tree(USER).xp)).toBe(true);
  });
});

describe('bounds', () => {
  it('a full ledger refuses the award, never truncates', async () => {
    const ids = Array.from({ length: AWARDED_TASK_IDS_MAX }, (_, i) => `id-${i}`);
    users.seed(USER, fresh({ xp: 1000, awardedTaskIds: ids }));

    const result = await award(USER, taskIdOf(1), NOW);

    expect(result).toMatchObject({ awarded: false, reason: 'ledger_full' });
    const tree = users.tree(USER) as { xp: number; awardedTaskIds: string[] };
    expect(tree.awardedTaskIds).toHaveLength(AWARDED_TASK_IDS_MAX);
    expect(tree.awardedTaskIds[0]).toBe('id-0');
    expect(tree.xp).toBe(1000);
  });

  it('one below the cap still accepts the last slot', async () => {
    const ids = Array.from({ length: AWARDED_TASK_IDS_MAX - 1 }, (_, i) => `id-${i}`);
    users.seed(USER, fresh({ xp: 10, awardedTaskIds: ids }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.awarded).toBe(true);
    expect((users.tree(USER).awardedTaskIds as string[]).length).toBe(AWARDED_TASK_IDS_MAX);
  });

  it('refuses at the xp ceiling instead of exceeding the safe-integer range', async () => {
    users.seed(USER, fresh({ xp: MAX_XP - 5 }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result).toMatchObject({ awarded: false, reason: 'xp_ceiling' });
    expect(users.tree(USER).xp).toBe(MAX_XP - 5);
  });
});

describe('failure and retry', () => {
  it('step 1 fails: nothing is recorded, and the retry awards exactly once', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1 });

    await expect(award(USER, taskIdOf(1), NOW)).rejects.toThrow('simulated database failure');
    expect(users.tree(USER)).toMatchObject({ xp: 0, awardedTaskIds: [] });

    const retry = await award(USER, taskIdOf(1), NOW);
    expect(retry.awarded).toBe(true);
    expect(users.tree(USER).xp).toBe(10);
  });

  it('step 2 fails after the award: the call THROWS derived_unpersisted, the XP stays recorded, and the retry reconciles without awarding again', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });

    await expect(award(USER, taskIdOf(1), NOW)).rejects.toMatchObject({ kind: 'derived_unpersisted' });
    // Durable: XP + ledger + the marker; the derived fields were NOT written.
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)], streakDays: 0, lastActiveDate: null, pendingDerivedDays: ['2026-10-06'] });

    const retry = await award(USER, taskIdOf(1), NOW);

    expect(retry).toMatchObject({ awarded: false, xpGained: 0, reason: 'already_awarded' });
    expect(retry.treeState).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy' });
    // The answer is what is PERSISTED, and the marker is gone.
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy', awardedTaskIds: [taskIdOf(1)] });
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
    expect(incrementsApplied()).toBe(1); // exactly one $inc in the whole sequence
  });

  it('once reconciled, further retries write nothing at all', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toBeInstanceOf(TreeAwardError);
    await award(USER, taskIdOf(1), NOW);

    const before = users.tree(USER);
    const mark = users.applied.length;
    const third = await award(USER, taskIdOf(1), DAY(2));

    expect(third).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(writesSince(mark)).toEqual([]);
    expect(users.tree(USER)).toEqual(before);
  });

  it('step 2 losing five compare-and-sets in a row throws derived_unpersisted — it never returns a projection — and a retry recovers', async () => {
    users.seed(USER, fresh());
    let guard = false;
    let bump = 100;
    let sabotage = true;
    users.hooks.before = async (op) => {
      if (!sabotage || guard || op.op !== 'findOneAndUpdate' || !isDerivedWrite(op)) return;
      guard = true;
      await users.model.updateOne({ _id: USER }, { $set: { 'treeState.streakDays': (bump += 1) } });
      guard = false;
    };

    const outcome = await award(USER, taskIdOf(1), NOW).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );

    expect(outcome).not.toHaveProperty('value'); // nothing was reported as the tree
    expect((outcome as { error: unknown }).error).toMatchObject({ kind: 'derived_unpersisted' });
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: ['2026-10-06'] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('lost repeated conflicts'));

    sabotage = false;
    const retry = await award(USER, taskIdOf(1), NOW);
    expect(retry).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(users.tree(USER)).toMatchObject({ xp: 10 });
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
    expect(incrementsApplied()).toBe(1);
  });

  it('five concurrent retries after a failed derived write all reconcile, and none awards', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toBeInstanceOf(TreeAwardError);

    const results = await Promise.all(Array.from({ length: 5 }, () => award(USER, taskIdOf(1), NOW)));

    expect(results.every((r) => r.awarded === false && r.reason === 'already_awarded')).toBe(true);
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06' });
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
    expect(incrementsApplied()).toBe(1);
  });

  it('a retry reconciles for the day the award was recorded, not the day of the retry', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);

    const retry = await award(USER, taskIdOf(1), DAY(3));

    expect(retry.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-06', health: 'dead' }); // 3 idle days by then
    expect(users.tree(USER).xp).toBe(10);
  });

  it('a LATER award also finishes a leftover derived write: the recorded day first, then today', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);

    const next = await award(USER, taskIdOf(2), DAY(1));

    expect(next).toMatchObject({ awarded: true });
    expect(next.treeState).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-07' });
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
  });

  describe('derived writes that keep failing across several UTC days (every award day must still count)', () => {
    // Day 0 = Tue 2026-10-06, day 1 = Wed, day 2 = Thu, ...
    const failDerivedOnce = () => users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });

    it('fails on day 0 and day 1, reconciles on day 2 by RETRYING: both award days count (streak 2, last active day 1)', async () => {
      users.seed(USER, fresh());
      failDerivedOnce();
      await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toMatchObject({ kind: 'derived_unpersisted' });
      failDerivedOnce();
      await expect(award(USER, taskIdOf(2), DAY(1))).rejects.toMatchObject({ kind: 'derived_unpersisted' });
      expect(users.tree(USER)).toMatchObject({ xp: 20, streakDays: 0, lastActiveDate: null });

      const retry = await award(USER, taskIdOf(1), DAY(2)); // no new XP: just the reconcile

      expect(retry).toMatchObject({ awarded: false, reason: 'already_awarded', xpGained: 0 });
      expect(retry.treeState).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-07', health: 'healthy' });
      expect(users.tree(USER)).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-07' });
      expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
      expect(incrementsApplied()).toBe(2);
    });

    it('fails on day 0 and day 1, then a NEW award on day 2 succeeds: streak 3 on day 2', async () => {
      users.seed(USER, fresh());
      failDerivedOnce();
      await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);
      failDerivedOnce();
      await expect(award(USER, taskIdOf(2), DAY(1))).rejects.toBeInstanceOf(TreeAwardError);

      const third = await award(USER, taskIdOf(3), DAY(2));

      expect(third).toMatchObject({ awarded: true });
      expect(third.treeState).toMatchObject({ xp: 30, streakDays: 3, lastActiveDate: '2026-10-08', health: 'healthy' });
      expect(users.tree(USER)).toMatchObject({ xp: 30, streakDays: 3, lastActiveDate: '2026-10-08' });
      expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
    });

    it('three failing days in a row (0, 1, 2), reconciled on day 3: streak 3, last active day 2', async () => {
      users.seed(USER, fresh());
      for (let day = 0; day < 3; day += 1) {
        failDerivedOnce();
        await expect(award(USER, taskIdOf(day + 1), DAY(day))).rejects.toBeInstanceOf(TreeAwardError);
      }

      const retry = await award(USER, taskIdOf(2), DAY(3));

      expect(retry.treeState).toMatchObject({ xp: 30, streakDays: 3, lastActiveDate: '2026-10-08', health: 'healthy' });
    });

    it('a skipped day still resets the streak: failures on day 0 and day 2, reconciled on day 3 -> streak 1, last active day 2', async () => {
      users.seed(USER, fresh());
      failDerivedOnce();
      await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);
      failDerivedOnce();
      await expect(award(USER, taskIdOf(2), DAY(2))).rejects.toBeInstanceOf(TreeAwardError);

      const retry = await award(USER, taskIdOf(1), DAY(3));

      expect(retry.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-08', health: 'healthy' });
    });

    it('12 concurrent awards on day 2 over a pending marker from days 0 and 1: streak 3, XP exact, marker cleared', async () => {
      users.seed(USER, fresh({ xp: 20, streakDays: 0, lastActiveDate: null, awardedTaskIds: [taskIdOf(90), taskIdOf(91)], pendingDerivedDays: ['2026-10-06', '2026-10-07'] }));

      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => award(USER, taskIdOf(i + 1), DAY(2))));

      expect(results.every((r) => r.awarded)).toBe(true);
      expect(users.tree(USER)).toMatchObject({ xp: 140, streakDays: 3, lastActiveDate: '2026-10-08' });
      expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
    });

    it('several failed awards on the SAME day count as one day', async () => {
      users.seed(USER, fresh());
      failDerivedOnce();
      await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);
      failDerivedOnce();
      await expect(award(USER, taskIdOf(2), new Date(DAY(0).getTime() + 3_600_000))).rejects.toBeInstanceOf(TreeAwardError);

      const retry = await award(USER, taskIdOf(1), DAY(1));

      expect(retry.treeState).toMatchObject({ xp: 20, streakDays: 1, lastActiveDate: '2026-10-06' });
    });

    it('an existing streak is extended across the failed days (4 -> 5 -> 6)', async () => {
      users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));
      failDerivedOnce();
      await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);
      failDerivedOnce();
      await expect(award(USER, taskIdOf(2), DAY(1))).rejects.toBeInstanceOf(TreeAwardError);

      const retry = await award(USER, taskIdOf(1), DAY(2));

      expect(retry.treeState).toMatchObject({ streakDays: 6, lastActiveDate: '2026-10-07' });
    });
  });

  it('re-completing an old, fully reconciled task changes nothing, so it cannot keep a streak alive', async () => {
    users.seed(USER, fresh());
    await award(USER, taskIdOf(1), DAY(0));
    const before = users.tree(USER);
    const mark = users.applied.length;

    const later = await award(USER, taskIdOf(1), DAY(5));

    expect(later).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(users.tree(USER)).toEqual(before);
    expect(writesSince(mark)).toEqual([]);
  });

  it('a malformed marker is never trusted as a query value: a non-string is ignored, an unparsable string is cleared without touching the streak', async () => {
    users.seed(USER, fresh({ xp: 10, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: { $gt: 0 } }));
    const mark = users.applied.length;
    const ignored = await award(USER, taskIdOf(1), NOW);
    expect(ignored.reason).toBe('already_awarded');
    expect(writesSince(mark)).toEqual([]);

    users.seed(USER, fresh({ xp: 10, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: ['garbage', 7, '2026-02-30'] }));
    const cleared = await award(USER, taskIdOf(1), NOW);
    expect(cleared.treeState).toMatchObject({ xp: 10, streakDays: 4, lastActiveDate: '2026-10-05' });
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
  });

  it('readPersistedGrowth reads the stored tree back (never a projection) and refuses ids that are not in the ledger', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toBeInstanceOf(TreeAwardError);

    const persisted = await readPersistedGrowth(USER, taskIdOf(1), NOW);
    expect(persisted).toMatchObject({ taskId: taskIdOf(1), awarded: true, xpGained: 10 });
    expect(persisted?.treeState).toMatchObject({ xp: 10, streakDays: 0, lastActiveDate: null }); // exactly what is stored
    expect(await readPersistedGrowth(USER, taskIdOf(2), NOW)).toBeUndefined();
    expect(await readPersistedGrowth('nobody', taskIdOf(1), NOW)).toBeUndefined();
  });
});
