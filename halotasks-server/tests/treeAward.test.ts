import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUserStore, taskIdOf, type UserStore } from './helpers/treeDoubles';
import { ACTIVE_DAYS_MAX, AWARDED_TASK_IDS_MAX, MAX_XP, presentTreeState, replayAwardDays } from '../src/utils/treeRules';
import { addDays } from '../src/utils/calendarDate';

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

// The derived write is the findOneAndUpdate that $sets the streak (the award carries $inc/$push/$addToSet; the
// one-time adoption of a legacy tree is an updateOne that $sets activeDays).
const isDerivedWrite = (op: { update?: Record<string, unknown> }) =>
  (op.update?.$set as Record<string, unknown> | undefined)?.['treeState.streakDays'] !== undefined;
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

describe('effective state in award responses (Issue #16)', () => {
  it('an already_awarded answer after idle days reports the effective (reset) streak while storage keeps the fold', async () => {
    users.seed(USER, fresh({ xp: 10, streakDays: 5, lastActiveDate: '2026-10-06', awardedTaskIds: [taskIdOf(1)] }));

    const result = await award(USER, taskIdOf(1), DAY(2)); // two days later: one missed day

    expect(result).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(result.treeState).toMatchObject({ status: 'wilting', streakDays: 0, health: 'wilting', xp: 10, daysSinceActive: 2 });
    expect(users.tree(USER)).toMatchObject({ streakDays: 5, lastActiveDate: '2026-10-06', xp: 10 });
    expect(users.applied).toHaveLength(0); // re-completing an old task is not activity: nothing written
  });

  it('readPersistedGrowth presents the effective state too, without writing', async () => {
    users.seed(USER, fresh({ xp: 10, streakDays: 5, lastActiveDate: '2026-10-06', awardedTaskIds: [taskIdOf(1)] }));
    const growth = await readPersistedGrowth(USER, taskIdOf(1), DAY(4));
    expect(growth?.treeState).toMatchObject({ status: 'dead', streakDays: 0, health: 'dead', xp: 10 });
    expect(users.applied).toHaveLength(0);
  });

  it('a new award after a long idle period restarts at 1 and is healthy at once; xp only grows', async () => {
    users.seed(USER, fresh({ xp: 250, streakDays: 30, lastActiveDate: '2026-08-01', stage: 'lush', awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(2), NOW);
    expect(result.treeState).toMatchObject({ status: 'active', streakDays: 1, health: 'healthy', xp: 260, stage: 'lush' });
  });
});

describe('streak and health (the existing UTC rule, now server-side)', () => {
  it.each([
    ['no previous activity', 0, null, 1],
    ['same day', 4, '2026-10-06', 4],
    ['yesterday', 4, '2026-10-05', 5],
    ['two days ago', 4, '2026-10-04', 1],
    ['a date one day ahead (clock skew between instances)', 4, '2026-10-07', 4],
    ['a date two or more days ahead (not explained by skew)', 4, '2999-01-01', 1],
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
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)], streakDays: 0, lastActiveDate: null, activeDays: ['2026-10-06'] });

    const retry = await award(USER, taskIdOf(1), NOW);

    expect(retry).toMatchObject({ awarded: false, xpGained: 0, reason: 'already_awarded' });
    expect(retry.treeState).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy' });
    // The answer is what is PERSISTED: the copy now equals the fold of the retained history.
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy', awardedTaskIds: [taskIdOf(1)], activeDays: ['2026-10-06'] });
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
    expect(users.tree(USER)).toMatchObject({ xp: 10, awardedTaskIds: [taskIdOf(1)], activeDays: ['2026-10-06'] });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('lost repeated conflicts'));

    sabotage = false;
    const retry = await award(USER, taskIdOf(1), NOW);
    expect(retry).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', activeDays: ['2026-10-06'] });
    expect(incrementsApplied()).toBe(1);
  });

  it('five concurrent retries after a failed derived write all reconcile, and none awards', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toBeInstanceOf(TreeAwardError);

    const results = await Promise.all(Array.from({ length: 5 }, () => award(USER, taskIdOf(1), NOW)));

    expect(results.every((r) => r.awarded === false && r.reason === 'already_awarded')).toBe(true);
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', activeDays: ['2026-10-06'] });
    expect(incrementsApplied()).toBe(1);
  });

  it('a retry reconciles for the day the award was recorded, not the day of the retry', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);

    const retry = await award(USER, taskIdOf(1), DAY(3));

    // The response is the EFFECTIVE state at the retry (3 idle days by then: streak 0, dead), the stored fold is the award day's.
    expect(retry.treeState).toMatchObject({ streakDays: 0, lastActiveDate: '2026-10-06', health: 'dead', status: 'dead', daysSinceActive: 3, xp: 10 });
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06' });
  });

  it('a LATER award also finishes a leftover derived write: the recorded day first, then today', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), DAY(0))).rejects.toBeInstanceOf(TreeAwardError);

    const next = await award(USER, taskIdOf(2), DAY(1));

    expect(next).toMatchObject({ awarded: true });
    expect(next.treeState).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-07' });
    expect(users.tree(USER)).toMatchObject({ streakDays: 2, lastActiveDate: '2026-10-07', activeDays: ['2026-10-06', '2026-10-07'] });
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
      expect(users.tree(USER)).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-07', activeDays: ['2026-10-06', '2026-10-07'] });
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
      expect(users.tree(USER)).toMatchObject({ xp: 30, streakDays: 3, lastActiveDate: '2026-10-08', activeDays: ['2026-10-06', '2026-10-07', '2026-10-08'] });
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

    it('12 concurrent awards on day 2 over a stale copy of days 0 and 1: streak 3, XP exact, history has each day once', async () => {
      users.seed(USER, fresh({ xp: 20, streakDays: 0, lastActiveDate: null, awardedTaskIds: [taskIdOf(90), taskIdOf(91)], activeDays: ['2026-10-06', '2026-10-07'] }));

      const results = await Promise.all(Array.from({ length: 12 }, (_, i) => award(USER, taskIdOf(i + 1), DAY(2))));

      expect(results.every((r) => r.awarded)).toBe(true);
      expect(users.tree(USER)).toMatchObject({ xp: 140, streakDays: 3, lastActiveDate: '2026-10-08', activeDays: ['2026-10-06', '2026-10-07', '2026-10-08'] });
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

  it('a malformed legacy marker is never trusted as a query value: a non-array or junk days are ignored and nothing is written', async () => {
    users.seed(USER, fresh({ xp: 10, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: { $gt: 0 } }));
    const mark = users.applied.length;
    const ignored = await award(USER, taskIdOf(1), NOW);
    expect(ignored.reason).toBe('already_awarded');
    expect(writesSince(mark)).toEqual([]);

    users.seed(USER, fresh({ xp: 10, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: ['garbage', 7, '2026-02-30'] }));
    const junk = await award(USER, taskIdOf(1), NOW);
    expect(junk.treeState).toMatchObject({ xp: 10, streakDays: 4, lastActiveDate: '2026-10-05' });
    expect(writesSince(mark)).toEqual([]);
  });

  it('readPersistedGrowth reads the stored tree back (never a projection) and refuses ids that are not in the ledger', async () => {
    users.seed(USER, fresh());
    users.faults.push({ op: 'findOneAndUpdate', count: 1, when: isDerivedWrite });
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toBeInstanceOf(TreeAwardError);

    const persisted = await readPersistedGrowth(USER, taskIdOf(1), NOW);
    expect(persisted).toMatchObject({ taskId: taskIdOf(1), awarded: true, xpGained: 10 });
    // Read back from storage (never a projection): the recorded award day is folded in memory, storage keeps the stale copy.
    expect(persisted?.treeState).toMatchObject({ xp: 10, streakDays: 1, lastActiveDate: '2026-10-06', status: 'active', health: 'healthy' });
    expect(users.tree(USER)).toMatchObject({ xp: 10, streakDays: 0, lastActiveDate: null, activeDays: ['2026-10-06'] });
    expect(await readPersistedGrowth(USER, taskIdOf(2), NOW)).toBeUndefined();
    expect(await readPersistedGrowth('nobody', taskIdOf(1), NOW)).toBeUndefined();
  });
});

describe('retained award-day history (Issue #16 AC8: recalculation from the same completion history)', () => {
  const activeDaysOf = () => (users.tree(USER) as { activeDays?: string[] }).activeDays;
  const consecutive = (count: number, end = '2026-10-05') => Array.from({ length: count }, (_, i) => addDays(end, i - count + 1));

  it('records the award day in the SAME atomic write as the XP and the ledger entry', async () => {
    users.seed(USER, fresh());
    await award(USER, taskIdOf(1), NOW);

    const write = users.applied.find((o) => o.update?.$inc);
    expect(write?.update).toEqual({
      $inc: { 'treeState.xp': 10 },
      $push: { 'treeState.awardedTaskIds': taskIdOf(1) },
      $addToSet: { 'treeState.activeDays': '2026-10-06' },
    });
    expect(activeDaysOf()).toEqual(['2026-10-06']);
  });

  it('one entry per UTC day: more awards the same day, retries and re-completions never add days', async () => {
    users.seed(USER, fresh());
    await Promise.all(Array.from({ length: 25 }, (_, i) => award(USER, taskIdOf(i + 1), NOW)));
    await award(USER, taskIdOf(1), NOW);
    await award(USER, taskIdOf(2), DAY(3)); // re-completing an old task is not activity
    expect(activeDaysOf()).toEqual(['2026-10-06']);
    expect(users.tree(USER)).toMatchObject({ xp: 250, streakDays: 1 });
  });

  it('a legacy tree adopts its history without losing its streak: the days implied by streak N ending on D', async () => {
    users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState).toMatchObject({ streakDays: 5, lastActiveDate: '2026-10-06', health: 'healthy' });
    expect(activeDaysOf()).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
  });

  it('adoption happens once, even with 12 concurrent first awards; the streak and every day are exact', async () => {
    users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));
    await Promise.all(Array.from({ length: 12 }, (_, i) => award(USER, taskIdOf(i + 1), NOW)));

    const adoptions = users.applied.filter((o) => o.op === 'updateOne' && (o.update?.$set as Record<string, unknown> | undefined)?.['treeState.activeDays']);
    expect(adoptions).toHaveLength(1);
    expect(users.tree(USER)).toMatchObject({ xp: 160, streakDays: 5, lastActiveDate: '2026-10-06' });
    expect(activeDaysOf()).toEqual(['2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
  });

  it('a legacy recovery-marker day is folded into the adopted history and the marker removed; a retry then repairs the copy', async () => {
    users.seed(USER, fresh({ xp: 20, streakDays: 1, lastActiveDate: '2026-10-04', awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: ['2026-10-05'] }));
    const mark = users.applied.length;

    const retry = await award(USER, taskIdOf(1), NOW);

    expect(retry).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(retry.treeState).toMatchObject({ streakDays: 2, lastActiveDate: '2026-10-05' });
    expect(users.tree(USER)).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-05', activeDays: ['2026-10-04', '2026-10-05'] });
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
    expect(writesSince(mark).some((o) => o.update?.$inc)).toBe(false);
  });

  it('a stored activeDays that is not an array is never overwritten: the award ends in conflict and changes nothing', async () => {
    users.seed(USER, fresh({ xp: 10, awardedTaskIds: ['old'], activeDays: 'junk' }));
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toMatchObject({ kind: 'conflict' });
    expect(users.tree(USER)).toMatchObject({ xp: 10, activeDays: 'junk', awardedTaskIds: ['old'] });
  });

  describe('the cap: never truncate, refuse instead', () => {
    it('a full history refuses a NEW day (history_full) and changes nothing', async () => {
      const days = consecutive(ACTIVE_DAYS_MAX, '2026-10-05');
      users.seed(USER, fresh({ xp: 100, streakDays: 3, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'], activeDays: days }));

      const result = await award(USER, taskIdOf(1), NOW);

      expect(result).toMatchObject({ awarded: false, reason: 'history_full', xpGained: 0 });
      expect(activeDaysOf()).toHaveLength(ACTIVE_DAYS_MAX);
      expect(activeDaysOf()?.[0]).toBe(days[0]); // the oldest day is still there
      expect(users.tree(USER)).toMatchObject({ xp: 100, awardedTaskIds: ['old'] });
    });

    it('a full history still accepts an award on a day it already holds (no growth)', async () => {
      const days = consecutive(ACTIVE_DAYS_MAX, '2026-10-06');
      users.seed(USER, fresh({ xp: 100, streakDays: 3, lastActiveDate: '2026-10-06', awardedTaskIds: ['old'], activeDays: days }));

      const result = await award(USER, taskIdOf(1), NOW);

      expect(result).toMatchObject({ awarded: true });
      expect(activeDaysOf()).toHaveLength(ACTIVE_DAYS_MAX);
      expect(users.tree(USER).xp).toBe(110);
    });

    it('one below the cap still accepts the last slot', async () => {
      users.seed(USER, fresh({ xp: 100, awardedTaskIds: ['old'], activeDays: consecutive(ACTIVE_DAYS_MAX - 1, '2026-10-05') }));
      const result = await award(USER, taskIdOf(1), NOW);
      expect(result.awarded).toBe(true);
      expect(activeDaysOf()).toHaveLength(ACTIVE_DAYS_MAX);
    });
  });

  describe('the history is canonical; the stored streak/date are a repairable copy', () => {
    const damaged = () =>
      users.seed(USER, fresh({ xp: 20, streakDays: 99, lastActiveDate: '2026-01-01', health: 'healthy', awardedTaskIds: [taskIdOf(1)], activeDays: ['2026-10-05', '2026-10-06'] }));

    it('a read presents the streak the history says, and writes nothing', async () => {
      damaged();
      const growth = await readPersistedGrowth(USER, taskIdOf(1), NOW);
      expect(growth?.treeState).toMatchObject({ streakDays: 2, lastActiveDate: '2026-10-06', status: 'active', xp: 20 });
      expect(users.applied).toHaveLength(0);
    });

    it('a retry repairs the copy from the history (lowering a wrong streak too) without awarding or touching xp, ledger or history', async () => {
      damaged();
      const retry = await award(USER, taskIdOf(1), NOW);

      expect(retry).toMatchObject({ awarded: false, reason: 'already_awarded' });
      expect(retry.treeState).toMatchObject({ streakDays: 2, lastActiveDate: '2026-10-06', health: 'healthy' });
      expect(users.tree(USER)).toMatchObject({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-06', awardedTaskIds: [taskIdOf(1)], activeDays: ['2026-10-05', '2026-10-06'] });
      expect(incrementsApplied()).toBe(0);
    });

    it('a consistent copy is left alone: an already-awarded retry writes nothing', async () => {
      users.seed(USER, fresh({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-06', awardedTaskIds: [taskIdOf(1)], activeDays: ['2026-10-05', '2026-10-06'] }));
      await award(USER, taskIdOf(1), NOW);
      expect(users.applied).toHaveLength(0);
    });
  });
});

const dayRange = (count: number, from: string) => Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));

describe('legacy adoption is bounded (Issue #16 review, item 1)', () => {
  const snapshot = () => users.get(USER);

  // A legacy tree: a long streak ending yesterday PLUS old recovery-marker days that overlap nothing.
  const legacyOverCap = (extra: Record<string, unknown> = {}) =>
    fresh({
      xp: 100,
      streakDays: 19_000,
      lastActiveDate: '2026-10-05',
      awardedTaskIds: ['old'],
      pendingDerivedDays: dayRange(1_500, '1900-01-01'), // 19,000 + 1,500 distinct days: over the cap
      ...extra,
    });

  it('a combined set (streak days + marker days) that exceeds the cap is REFUSED (history_full) and the legacy record is untouched', async () => {
    users.seed(USER, legacyOverCap());
    const before = snapshot();

    const result = await award(USER, taskIdOf(1), NOW);

    expect(result).toMatchObject({ awarded: false, reason: 'history_full', xpGained: 0 });
    expect(snapshot()).toEqual(before); // byte-identical: no activeDays, marker still there, xp and ledger unchanged
    expect(users.applied).toHaveLength(0);
    expect(snapshot().treeState).not.toHaveProperty('activeDays');
  });

  it('the same record on an already-awarded RETRY: nothing is written, the answer is already_awarded', async () => {
    users.seed(USER, legacyOverCap({ awardedTaskIds: [taskIdOf(1)] }));
    const before = snapshot();

    const retry = await award(USER, taskIdOf(1), NOW);

    expect(retry).toMatchObject({ awarded: false, reason: 'already_awarded' });
    expect(snapshot()).toEqual(before);
    expect(users.applied).toHaveLength(0);
  });

  it('a record whose set (with the slot for today) fits exactly is adopted and awarded', async () => {
    // 19,000 streak days ending yesterday + 999 old marker days = 19,999 distinct; today makes exactly 20,000.
    users.seed(USER, legacyOverCap({ pendingDerivedDays: dayRange(999, '1900-01-01') }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result).toMatchObject({ awarded: true });
    expect((users.tree(USER).activeDays as string[]).length).toBe(ACTIVE_DAYS_MAX);
    expect(users.tree(USER)).not.toHaveProperty('pendingDerivedDays');
  });

  it('one more marker day than fits (20,000 distinct + today = 20,001) is refused, not shortened', async () => {
    users.seed(USER, legacyOverCap({ pendingDerivedDays: dayRange(1_000, '1900-01-01') }));
    const before = snapshot();
    expect(await award(USER, taskIdOf(1), NOW)).toMatchObject({ awarded: false, reason: 'history_full' });
    expect(snapshot()).toEqual(before);
  });

  it('a streak the history can never hold (forged huge value) is refused whole: never clamped to a different streak', async () => {
    users.seed(USER, fresh({ xp: 100, streakDays: 1e9, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));
    const before = snapshot();
    expect(await award(USER, taskIdOf(1), NOW)).toMatchObject({ awarded: false, reason: 'history_full' });
    expect(snapshot()).toEqual(before);
    expect(users.applied).toHaveLength(0);
  });

  it('12 concurrent awards on a refused record all refuse and none writes', async () => {
    users.seed(USER, legacyOverCap());
    const before = snapshot();
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => award(USER, taskIdOf(i + 1), NOW)));
    expect(results.every((r) => r.awarded === false && r.reason === 'history_full')).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(users.applied).toHaveLength(0);
  });
});

describe('stored history integrity: the award path never repairs a malformed history (Issue #16 review, item 2)', () => {
  const snapshot = () => users.get(USER);
  const valid = ['2026-10-04', '2026-10-05'];

  const malformed: [string, unknown, string][] = [
    ['a string', 'junk', 'not_an_array'],
    ['a number', 42, 'not_an_array'],
    ['an object', { $gt: 0 }, 'not_an_array'],
    ['an unparsable entry', [...valid, 'junk'], 'invalid_date'],
    ['an impossible calendar date', [...valid, '2026-02-30'], 'invalid_date'],
    ['a non-string entry', [...valid, 7], 'invalid_date'],
    ['a duplicate day', [...valid, '2026-10-05'], 'duplicate_day'],
    ['a duplicate of TODAY', [...valid, '2026-10-06', '2026-10-06'], 'duplicate_day'],
    ['an array over the cap', dayRange(ACTIVE_DAYS_MAX + 1, '1970-01-01'), 'over_cap'],
    ['an array over the cap that already holds today', [...dayRange(ACTIVE_DAYS_MAX, '1970-01-01'), '2026-10-06'], 'over_cap'],
  ];

  it.each(malformed)('%s: the award ends in conflict, writes nothing and leaves the record byte-identical', async (_label, activeDays, reason) => {
    users.seed(USER, fresh({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'], activeDays }));
    const before = snapshot();

    await expect(award(USER, taskIdOf(1), NOW)).rejects.toMatchObject({ kind: 'conflict' });

    expect(snapshot()).toEqual(before); // nothing deduplicated, dropped, truncated or rewritten
    expect(users.applied).toHaveLength(0);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(reason));
    // The log names the failed rule only, never any of the stored data.
    expect(vi.mocked(console.error).mock.calls.flat().join(' ')).not.toContain('junk');
  });

  it('an already-awarded retry on a malformed history is refused too (integrity cannot be established), and writes nothing', async () => {
    users.seed(USER, fresh({ xp: 20, streakDays: 99, lastActiveDate: '2026-01-01', awardedTaskIds: [taskIdOf(1)], activeDays: [...valid, valid[0]] }));
    const before = snapshot();
    await expect(award(USER, taskIdOf(1), NOW)).rejects.toMatchObject({ kind: 'conflict' });
    expect(snapshot()).toEqual(before);
    expect(users.applied).toHaveLength(0);
  });

  it('12 concurrent awards on a malformed history all refuse and none writes', async () => {
    users.seed(USER, fresh({ xp: 20, awardedTaskIds: ['old'], activeDays: [...valid, valid[0]] }));
    const before = snapshot();
    const outcomes = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => award(USER, taskIdOf(i + 1), NOW)));
    expect(outcomes.every((o) => o.status === 'rejected' && (o.reason as { kind?: string }).kind === 'conflict')).toBe(true);
    expect(snapshot()).toEqual(before);
    expect(users.applied).toHaveLength(0);
  });

  it('READS cannot refuse: they fold the valid, distinct entries in memory and write nothing', async () => {
    users.seed(USER, fresh({ xp: 20, awardedTaskIds: [taskIdOf(1)], activeDays: ['2026-10-05', 'junk', '2026-10-05', 7, '2026-10-06'] }));
    const before = snapshot();
    const growth = await readPersistedGrowth(USER, taskIdOf(1), NOW);
    expect(growth?.treeState).toMatchObject({ streakDays: 2, lastActiveDate: '2026-10-06', status: 'active' });
    expect(snapshot()).toEqual(before);
    expect(users.applied).toHaveLength(0);
  });

  it('a valid history is accepted in any insertion order and is NOT rewritten (only appended to)', async () => {
    users.seed(USER, fresh({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'], activeDays: ['2026-10-05', '2026-10-04'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result).toMatchObject({ awarded: true });
    expect(result.treeState).toMatchObject({ streakDays: 3, lastActiveDate: '2026-10-06' });
    expect(users.tree(USER).activeDays).toEqual(['2026-10-05', '2026-10-04', '2026-10-06']); // original order kept
  });

  it('exactly at the cap with only valid, distinct days is NOT malformed: a new day is history_full, a held day is accepted', async () => {
    const days = dayRange(ACTIVE_DAYS_MAX, '1970-01-01');
    users.seed(USER, fresh({ xp: 20, awardedTaskIds: ['old'], activeDays: days }));
    const before = snapshot();
    expect(await award(USER, taskIdOf(1), NOW)).toMatchObject({ awarded: false, reason: 'history_full' });
    expect(snapshot()).toEqual(before);

    users.seed(USER, fresh({ xp: 20, awardedTaskIds: ['old'], activeDays: [...days.slice(1), '2026-10-06'] }));
    expect(await award(USER, taskIdOf(1), NOW)).toMatchObject({ awarded: true });
  });
});

describe('migration edge cases: adoption keeps only what a legacy record defensibly supports (Issue #16 review, item 5)', () => {
  const adoptedDays = () => (users.tree(USER) as { activeDays: string[] }).activeDays;

  it.each([
    ['yesterday', '2026-10-05'],
    ['today', '2026-10-06'],
    ['long ago', '2026-01-01'],
  ])('a ZERO streak with a valid last-active date (%s) infers no days: the date alone is not a streak', async (_label, lastActiveDate) => {
    users.seed(USER, fresh({ xp: 30, streakDays: 0, lastActiveDate, awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(adoptedDays()).toEqual(['2026-10-06']); // only the day just awarded
    expect(result.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy' });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['an unparsable string', 'junk'],
    ['an impossible calendar date', '2026-02-30'],
    ['a timestamp', '2026-10-05T10:00:00Z'],
    ['a number', 20261005],
  ])('a streak of 4 with a %s last-active date infers no days: the streak is not invented', async (_label, lastActiveDate) => {
    users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate, awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(adoptedDays()).toEqual(['2026-10-06']);
    expect(result.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-06' });
  });

  it('a negative or non-finite stored streak is no streak', async () => {
    for (const streakDays of [-5, Infinity, NaN, '7']) {
      users.reset();
      users.seed(USER, fresh({ xp: 40, streakDays, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));
      const result = await award(USER, taskIdOf(1), NOW);
      expect(result.treeState.streakDays).toBe(1);
      expect(adoptedDays()).toEqual(['2026-10-06']);
    }
  });

  it('a last-active date ONE day ahead (clock skew) is trusted as ending today: the streak is preserved, never extended', async () => {
    users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate: '2026-10-07', awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState).toMatchObject({ streakDays: 4, lastActiveDate: '2026-10-06' });
    expect(adoptedDays()).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']); // no future day is stored
  });

  it.each([
    ['two days ahead', '2026-10-08'],
    ['far in the future', '2999-01-01'],
  ])('a last-active date %s is not explained by skew: nothing is inferred and no streak is invented', async (_label, lastActiveDate) => {
    users.seed(USER, fresh({ xp: 40, streakDays: 4, lastActiveDate, awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-06' });
    expect(adoptedDays()).toEqual(['2026-10-06']);
    expect(adoptedDays().every((day) => day <= '2026-10-06')).toBe(true); // never a future day in the history
  });

  it('a supported streak is carried exactly: 3 days ending yesterday + today = streak 4, with exactly those days stored', async () => {
    users.seed(USER, fresh({ xp: 40, streakDays: 3, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState.streakDays).toBe(4);
    expect(adoptedDays()).toEqual(['2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06']);
  });

  it('a streak that ended long ago is adopted as it was, then the new award restarts at 1 (the gap rule, unchanged)', async () => {
    users.seed(USER, fresh({ xp: 40, streakDays: 3, lastActiveDate: '2026-09-01', awardedTaskIds: ['old'] }));
    const result = await award(USER, taskIdOf(1), NOW);
    expect(result.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-06' });
    expect(adoptedDays()).toEqual(['2026-08-30', '2026-08-31', '2026-09-01', '2026-10-06']);
  });

  it('a retry-only adoption (legacy marker day, no new award) never infers a day from a zero streak either', async () => {
    users.seed(USER, fresh({ xp: 20, streakDays: 0, lastActiveDate: '2026-10-04', awardedTaskIds: [taskIdOf(1)], pendingDerivedDays: ['2026-10-05'] }));
    const retry = await award(USER, taskIdOf(1), NOW);
    expect(adoptedDays()).toEqual(['2026-10-05']);
    expect(retry.treeState).toMatchObject({ streakDays: 1, lastActiveDate: '2026-10-05' });
  });
});

describe('property: storage matches the log of atomic award records (Issue #16 review, item 3)', () => {
  // The expectations below come ONLY from (a) the seed, (b) the double's log of operations that actually APPLIED
  // (`users.applied`: each one is a real atomic award write), and (c) an oracle written here, deliberately NOT
  // the implementation's nextStreak / replayAwardDays / needsReconcile. A bug that is also in those cannot hide.
  const MS_DAY = 86_400_000;
  const dayOf = (date: Date) => date.toISOString().slice(0, 10);

  // Independent oracle: the streak of an award-day set is the run of consecutive days ending on its latest day.
  const oracle = (days: string[]) => {
    const sorted = [...new Set(days)].sort();
    if (sorted.length === 0) return { streakDays: 0, lastActiveDate: null as string | null };
    let run = 1;
    for (let i = sorted.length - 1; i > 0 && Date.parse(sorted[i]) - Date.parse(sorted[i - 1]) === MS_DAY; i -= 1) run += 1;
    return { streakDays: run, lastActiveDate: sorted[sorted.length - 1] };
  };

  const seeds = [
    { name: 'empty legacy tree', doc: fresh(), days: [] as string[], ledger: [] as string[], xp: 0 },
    {
      name: 'legacy streak of 3 ending 2026-10-05',
      doc: fresh({ xp: 30, streakDays: 3, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'] }),
      days: ['2026-10-03', '2026-10-04', '2026-10-05'], // written out by hand: 3 consecutive days ending on the date
      ledger: ['old'],
      xp: 30,
    },
    {
      name: 'already-adopted history',
      doc: fresh({ xp: 20, streakDays: 2, lastActiveDate: '2026-10-05', awardedTaskIds: ['old'], activeDays: ['2026-10-04', '2026-10-05'] }),
      days: ['2026-10-04', '2026-10-05'],
      ledger: ['old'],
      xp: 20,
    },
  ];

  type Call = { id: string; day: string; result?: { awarded: boolean; reason?: string }; error?: string };
  const stats = { runs: 0, step1Faults: 0, derivedFaults: 0, adoptFaults: 0, concurrentSteps: 0, staleObservations: 0, readsChecked: 0, recordedAwards: 0, retries: 0 };

  it.each(Array.from({ length: 60 }, (_, run) => run))('run %i: ledger, xp, history and streak all agree with what was actually recorded', async (run) => {
    let state = 7_000 + run;
    const random = () => ((state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296);

    const seed = seeds[run % seeds.length];
    users.reset();
    users.seed(USER, seed.doc);

    const calls: Call[] = [];
    const attempt = async (id: string, now: Date) => {
      const call: Call = { id, day: dayOf(now) };
      calls.push(call);
      try {
        call.result = await award(USER, id, now);
      } catch (error) {
        call.error = (error as { kind?: string }).kind ?? (error as Error).message;
      }
    };

    // Deterministic fault injection: each fault is scheduled from the seeded generator, keyed on the SHAPE of the
    // write it targets (never on timing), and counted only if it actually fired.
    const fired = { step1: 0, derived: 0, adopt: 0 };
    const inject = (kind: 'step1' | 'derived' | 'adopt') => {
      const fault =
        kind === 'step1'
          ? { op: 'findOneAndUpdate', count: 1, when: (op: { update?: Record<string, unknown> }) => Boolean(op.update?.$inc) }
          : kind === 'derived'
            ? { op: 'findOneAndUpdate', count: 1, when: isDerivedWrite }
            : { op: 'updateOne', count: 1 };
      users.faults.push(fault);
      return () => {
        if (fault.count === 0) fired[kind] += 1;
      };
    };

    const ids: string[] = [...seed.ledger];
    let offset = 0;
    let nextTask = 1;
    let concurrent = 0;
    let retries = 0;

    for (let step = 0; step < 14; step += 1) {
      offset += Math.floor(random() * 3); // same day, next day, or a skipped day
      const now = DAY(offset);

      const settle: Array<() => void> = [];
      const roll = random();
      if (step === 0 && !('activeDays' in seed.doc) && random() < 0.5) settle.push(inject('adopt')); // adoption itself fails
      else if (roll < 0.25) settle.push(inject('derived'));
      else if (roll < 0.4) settle.push(inject('step1'));
      else if (roll < 0.5) settle.push(inject('adopt'));

      const action = random();
      if (action < 0.55) {
        const id = taskIdOf(nextTask++);
        ids.push(id);
        await attempt(id, now);
      } else if (action < 0.8) {
        concurrent += 1;
        const batch = [taskIdOf(nextTask++), taskIdOf(nextTask++), taskIdOf(nextTask++)];
        ids.push(...batch);
        await Promise.all(batch.map((id) => attempt(id, now)));
      } else {
        retries += 1;
        await attempt(ids[Math.floor(random() * ids.length)] ?? taskIdOf(nextTask++), now);
      }

      for (const done of settle) done();
      users.faults.length = 0; // a fault that did not fire does not leak into the next step

      // After EVERY step: is the stored copy behind the history, and does a (write-free) read already show the
      // right answer anyway? The expected answer is the oracle over the stored history, plus the idle rule
      // (two or more days since the last award = no current streak).
      const snapshot = users.tree(USER) as { activeDays?: string[]; streakDays: number; lastActiveDate: string | null };
      if (snapshot.activeDays && snapshot.activeDays.length > 0) {
        const expected = oracle(snapshot.activeDays);
        if (snapshot.streakDays !== expected.streakDays || snapshot.lastActiveDate !== expected.lastActiveDate) stats.staleObservations += 1;

        const writesBefore = users.applied.length;
        const shown = presentTreeState(users.tree(USER), now);
        const idleDays = Math.floor((Date.parse(dayOf(now)) - Date.parse(expected.lastActiveDate as string)) / MS_DAY);
        expect(shown.lastActiveDate).toBe(expected.lastActiveDate);
        expect(shown.streakDays).toBe(idleDays >= 2 ? 0 : expected.streakDays);
        expect(users.applied).toHaveLength(writesBefore); // a read writes nothing
        stats.readsChecked += 1;
      }
    }

    const lastDay = DAY(offset);
    const tree = () => users.tree(USER) as { xp: number; awardedTaskIds: string[]; activeDays?: string[]; streakDays: number; lastActiveDate: string | null };

    // The log of REAL atomic award writes (an operation that matched and applied): id, day.
    const awards = users.applied
      .filter((op) => op.update?.$inc)
      .map((op) => ({
        id: (op.update?.$push as Record<string, string>)['treeState.awardedTaskIds'],
        day: (op.update?.$addToSet as Record<string, string>)['treeState.activeDays'],
      }));

    // Final reconcile: retry a task that is in the ledger (no faults any more). Whatever the failures were, this
    // is the only thing needed to bring the stored copy in line.
    const known = tree().awardedTaskIds.find((id) => id !== 'old') ?? tree().awardedTaskIds[0];
    if (known !== undefined) await attempt(known, lastDay);

    const after = tree();

    // 1. The ledger is the seed plus exactly the ids of the recorded award writes, in order, each once.
    expect(after.awardedTaskIds).toEqual([...seed.ledger, ...awards.map((a) => a.id)]);
    expect(new Set(after.awardedTaskIds).size).toBe(after.awardedTaskIds.length);

    // 2. XP is the seed plus 10 per recorded award write: nothing lost, nothing doubled, whatever failed.
    expect(after.xp).toBe(seed.xp + 10 * awards.length);

    // 3. Every call's outcome is explained by that log.
    const recordedIds = new Set(awards.map((a) => a.id));
    for (const call of calls) {
      if (call.result?.awarded) {
        expect(awards.filter((a) => a.id === call.id)).toEqual([{ id: call.id, day: call.day }]); // recorded, on that call's day
      } else if (call.result) {
        expect(call.result.reason).toBe('already_awarded');
        expect(recordedIds.has(call.id) || seed.ledger.includes(call.id)).toBe(true);
      } else {
        expect(['derived_unpersisted', 'simulated database failure']).toContain(call.error);
        if (call.error === 'derived_unpersisted') expect(recordedIds.has(call.id) || seed.ledger.includes(call.id)).toBe(true);
      }
    }

    // 4. The history is the seed's days plus exactly the days of the recorded award writes (no phantom day, no lost day, no duplicate).
    if (awards.length > 0) {
      expect(after.activeDays).toBeDefined();
      expect([...(after.activeDays ?? [])].sort()).toEqual([...new Set([...seed.days, ...awards.map((a) => a.day)])].sort());
      expect(new Set(after.activeDays).size).toBe(after.activeDays?.length);
    } else if (after.activeDays) {
      expect([...after.activeDays].sort()).toEqual([...seed.days].sort()); // adopted, but nothing was ever recorded
    }

    // 5. The stored streak and last-active date equal the independent oracle over that history.
    if (after.activeDays) {
      expect({ streakDays: after.streakDays, lastActiveDate: after.lastActiveDate }).toEqual(oracle(after.activeDays));
    } else {
      expect(awards).toHaveLength(0); // an award can only ever be recorded on an adopted history
    }

    stats.runs += 1;
    stats.step1Faults += fired.step1;
    stats.derivedFaults += fired.derived;
    stats.adoptFaults += fired.adopt;
    stats.concurrentSteps += concurrent;
    stats.retries += retries;
    stats.recordedAwards += awards.length;
  });

  it('the scenarios above really exercised failures, concurrency, stale copies and retries (the property cannot pass vacuously)', () => {
    expect(stats.runs).toBe(60);
    expect(stats.step1Faults).toBeGreaterThanOrEqual(30);
    expect(stats.derivedFaults).toBeGreaterThanOrEqual(30);
    expect(stats.adoptFaults).toBeGreaterThanOrEqual(8);
    expect(stats.concurrentSteps).toBeGreaterThanOrEqual(30);
    expect(stats.staleObservations).toBeGreaterThanOrEqual(40); // stored copies genuinely lagged the history, often
    expect(stats.readsChecked).toBeGreaterThanOrEqual(300);
    expect(stats.retries).toBeGreaterThanOrEqual(20);
    expect(stats.recordedAwards).toBeGreaterThanOrEqual(200);
  });
});
