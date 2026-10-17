import { describe, expect, it } from 'vitest';
import {
  ACTIVE_DAYS_MAX,
  AWARDED_TASK_IDS_MAX,
  AWARDED_TASK_ID_MAX_LENGTH,
  MAX_XP,
  STAGE_THRESHOLDS,
  TREE_REWARD_FIELDS,
  XP_PER_COMPLETION,
  XP_PER_LEAF,
  deriveTreeStatus,
  effectiveFold,
  impliedStreakDays,
  planLegacyAdoption,
  validateActiveDays,
  needsReconcile,
  normalizeActiveDays,
  presentTreeState,
  replayAwardDays,
  daysBetween,
  getHealthForStreak,
  getLeavesForXp,
  getStageForXp,
  getTodayUtc,
  isValidAwardedTaskId,
  nextStreak,
  normalizeLastActiveDate,
  normalizePendingDays,
  normalizeStreakDays,
  normalizeTreeState,
  normalizeXp,
  summarizeTree,
} from '../src/utils/treeRules';

// Issue #24 — the Growth Tree rules, in isolation. Pure functions: no clock, no database.

const NOW = new Date('2026-10-06T10:00:00.000Z');

describe('constants shared with the client copy (halotasks-client/src/growth/treeRules.parity.test.ts pins the same numbers)', () => {
  it('keeps today\'s product numbers', () => {
    expect(XP_PER_COMPLETION).toBe(10);
    expect(XP_PER_LEAF).toBe(20);
    expect(STAGE_THRESHOLDS).toEqual({ seed: 0, sprout: 20, young: 60, mature: 120, lush: 250 });
  });

  it('lists every field a client may not write', () => {
    expect([...TREE_REWARD_FIELDS].sort()).toEqual(
      ['awardedTaskIds', 'health', 'lastActiveDate', 'lastCalculatedAt', 'leaves', 'stage', 'streakDays', 'xp'],
    );
  });

  it('bounds the ledger well inside the 16 MB document limit', () => {
    expect(AWARDED_TASK_IDS_MAX).toBe(20_000);
    expect(AWARDED_TASK_IDS_MAX * (AWARDED_TASK_ID_MAX_LENGTH + 8)).toBeLessThan(16 * 1024 * 1024);
  });
});

describe('derivations', () => {
  it.each([
    [0, 'seed'], [19, 'seed'], [20, 'sprout'], [59, 'sprout'], [60, 'young'],
    [119, 'young'], [120, 'mature'], [249, 'mature'], [250, 'lush'], [1_000_000, 'lush'],
  ] as const)('xp %i is stage %s', (xp, stage) => {
    expect(getStageForXp(xp)).toBe(stage);
  });

  it.each([[0, 0], [19, 0], [20, 1], [39, 1], [40, 2], [999, 49]])('xp %i has %i leaves', (xp, leaves) => {
    expect(getLeavesForXp(xp)).toBe(leaves);
  });

  it('uses the UTC calendar day, as the client always has', () => {
    expect(getTodayUtc(new Date('2026-10-06T23:59:59.999Z'))).toBe('2026-10-06');
    expect(getTodayUtc(new Date('2026-10-07T00:00:00.000Z'))).toBe('2026-10-07');
  });

  it('counts whole days between dates, and treats "no date" as 0', () => {
    expect(daysBetween('2026-10-05', '2026-10-06')).toBe(1);
    expect(daysBetween('2026-10-01', '2026-10-06')).toBe(5);
    expect(daysBetween(null, '2026-10-06')).toBe(0);
    expect(daysBetween('2026-10-07', '2026-10-06')).toBe(-1);
  });
});

describe('nextStreak: the existing rule, unchanged', () => {
  const today = '2026-10-06';

  it.each([
    ['first ever completion', 0, null, 1, today],
    ['already active today: nothing changes', 4, today, 4, today],
    ['active yesterday: streak continues', 4, '2026-10-05', 5, today],
    ['missed a day: streak restarts', 4, '2026-10-04', 1, today],
    ['missed many days: streak restarts', 9, '2026-09-01', 1, today],
    ['last active in the future: streak unchanged, date moves to today', 4, '2026-10-09', 4, today],
  ] as const)('%s', (_label, streakDays, lastActiveDate, expectedStreak, expectedDate) => {
    expect(nextStreak(streakDays, lastActiveDate, today)).toEqual({ streakDays: expectedStreak, lastActiveDate: expectedDate });
  });
});

describe('getHealthForStreak: unchanged for streak 0 and idle gaps (the 1-day gap now needs a stored streak, see deriveTreeStatus)', () => {
  const today = '2026-10-06';

  it.each([
    [0, today, 'dead'],
    [0, null, 'dead'],
    [3, today, 'healthy'],
    [3, '2026-10-05', 'healthy'],
    [3, '2026-10-04', 'wilting'],
    [3, '2026-10-03', 'dead'],
    [3, '2026-09-01', 'dead'],
  ] as const)('streak %i, last active %s -> %s', (streak, last, health) => {
    expect(getHealthForStreak(streak, last, today)).toBe(health);
  });
});

// Issue #16 — the reset / health / recovery rules. PARITY TABLE: halotasks-client/src/growth/treeRules.parity.test.ts
// holds a byte-identical copy of these rows (the client only previews; the server decides).
// [label, streakDays, lastActiveDate, xp, status, effectiveStreak, health, daysSinceActive]
const STATUS_CASES = [
  ['nothing ever earned', 0, null, 0, 'unstarted', 0, 'dead', null],
  ['xp but no recorded date (legacy)', 0, null, 40, 'unrecorded', 0, 'dead', null],
  ['a date but a stored streak of 0 (legacy)', 0, '2026-10-06', 40, 'unrecorded', 0, 'dead', 0],
  ['a date from yesterday but a stored streak of 0 (legacy)', 0, '2026-10-05', 40, 'unrecorded', 0, 'dead', 1],
  ['stale legacy zero streak, one missed day: thresholds win', 0, '2026-10-04', 40, 'wilting', 0, 'wilting', 2],
  ['stale legacy zero streak, two missed days: thresholds win', 0, '2026-10-03', 40, 'dead', 0, 'dead', 3],
  ['completed today', 4, '2026-10-06', 40, 'active', 4, 'healthy', 0],
  ['completed yesterday: streak still alive, today open', 4, '2026-10-05', 40, 'at_risk', 4, 'healthy', 1],
  ['one missed day', 4, '2026-10-04', 40, 'wilting', 0, 'wilting', 2],
  ['two missed days', 4, '2026-10-03', 40, 'dead', 0, 'dead', 3],
  ['many missed days', 9, '2026-09-01', 900, 'dead', 0, 'dead', 35],
  ['last active in the future (clock skew)', 4, '2026-10-09', 40, 'active', 4, 'healthy', 0],
] as const;

describe('deriveTreeStatus: exact, non-overlapping conditions (Issue #16)', () => {
  const today = '2026-10-06';

  it.each(STATUS_CASES)('%s', (_label, streak, last, xp, status, effective, health, since) => {
    expect(deriveTreeStatus(streak, last, xp, today)).toEqual({ status, effectiveStreakDays: effective, health, daysSinceActive: since });
  });

  it('assigns every gap from -3 to 40 exactly one status, changing only at the documented thresholds', () => {
    const statusAt = (gap: number) => {
      const last = new Date(Date.UTC(2026, 9, 6) - gap * 86_400_000).toISOString().split('T')[0];
      return deriveTreeStatus(5, last, 50, today).status;
    };
    const seen: string[] = [];
    for (let gap = -3; gap <= 40; gap += 1) seen.push(statusAt(gap));
    expect(seen.slice(0, 4)).toEqual(['active', 'active', 'active', 'active']); // gap -3..0
    expect(seen[4]).toBe('at_risk'); // gap 1
    expect(seen[5]).toBe('wilting'); // gap 2
    expect(new Set(seen.slice(6))).toEqual(new Set(['dead'])); // gap 3..40
  });

  it('flips on the UTC midnight boundary, not before', () => {
    const at = (iso: string) => deriveTreeStatus(3, '2026-10-05', 30, getTodayUtc(new Date(iso))).status;
    expect(at('2026-10-06T23:59:59.999Z')).toBe('at_risk');
    expect(at('2026-10-07T00:00:00.000Z')).toBe('wilting');
    expect(deriveTreeStatus(3, '2026-10-05', 30, getTodayUtc(new Date('2026-10-08T00:00:00.000Z'))).status).toBe('dead');
  });

  it('getHealthForStreak is the same rule (health of deriveTreeStatus)', () => {
    for (const [, streak, last, xp, , , health] of STATUS_CASES) {
      expect(getHealthForStreak(streak, last, today)).toBe(health);
      expect(xp).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('presentTreeState: effective state, never a change to XP or stage', () => {
  const stored = { xp: 130, streakDays: 7, lastActiveDate: '2026-10-01', awardedTaskIds: ['a'] };

  it('shows streak 0 / dead after idle days but keeps xp, leaves, stage and ledger exactly', () => {
    const state = presentTreeState(stored, NOW);
    expect(state).toMatchObject({ status: 'dead', streakDays: 0, health: 'dead', daysSinceActive: 5, xp: 130, leaves: 6, stage: 'mature', awardedTaskIds: ['a'] });
  });

  it('never lowers xp, leaves or stage as days pass; only the streak and health change', () => {
    let previous = presentTreeState(stored, new Date('2026-10-01T10:00:00Z'));
    for (let day = 1; day <= 400; day += 1) {
      const current = presentTreeState(stored, new Date(Date.UTC(2026, 9, 1 + day, 10)));
      expect(current.xp).toBe(previous.xp);
      expect(current.leaves).toBe(previous.leaves);
      expect(current.stage).toBe(previous.stage);
      previous = current;
    }
  });

  it('does not mutate its input (a read is not a write)', () => {
    const input = JSON.parse(JSON.stringify(stored));
    const frozen = JSON.parse(JSON.stringify(stored));
    presentTreeState(input, NOW);
    expect(input).toEqual(frozen);
  });

  it('folds recorded-but-unreconciled award days into the effective state, in memory only', () => {
    // Fold says "dead" (last 2026-10-01), but an award on 2026-10-06 (today) is still pending: the tree is healthy.
    const pending = { ...stored, pendingDerivedDays: ['2026-10-06'] };
    expect(presentTreeState(pending, NOW)).toMatchObject({ status: 'active', health: 'healthy', streakDays: 1, lastActiveDate: '2026-10-06', xp: 130 });
    // Yesterday's pending award on a live streak continues it; junk entries are ignored.
    const live = { xp: 50, streakDays: 3, lastActiveDate: '2026-10-04', awardedTaskIds: ['a'], pendingDerivedDays: ['2026-10-05', 'junk', 7] };
    expect(presentTreeState(live, NOW)).toMatchObject({ status: 'at_risk', streakDays: 4, lastActiveDate: '2026-10-05' });
    expect(live.pendingDerivedDays).toEqual(['2026-10-05', 'junk', 7]);
  });

  it('without a marker the stored fold is shown as is', () => {
    expect(presentTreeState(stored, NOW).lastActiveDate).toBe('2026-10-01');
    expect(presentTreeState({ ...stored, pendingDerivedDays: undefined }, NOW).status).toBe('dead');
  });

  it('clock skew: a stored last-active date in the FUTURE does not hide a recorded award for today (read only, nothing written)', () => {
    const skewed = { xp: 40, streakDays: 4, lastActiveDate: '2026-10-09', awardedTaskIds: ['a'], pendingDerivedDays: ['2026-10-06'] };
    const frozen = structuredClone(skewed);
    // nextStreak moves a future date back to the award day and keeps the streak; the read shows exactly that.
    expect(presentTreeState(skewed, NOW)).toMatchObject({ status: 'active', health: 'healthy', streakDays: 4, lastActiveDate: '2026-10-06', xp: 40 });
    expect(skewed).toEqual(frozen);
    // Without the pending day the future date is shown as stored (active: done "today", a future date too).
    expect(presentTreeState({ ...skewed, pendingDerivedDays: undefined }, NOW)).toMatchObject({ status: 'active', lastActiveDate: '2026-10-09' });
  });

  it('an adopted tree (activeDays present) is presented from its history alone; the stored streak and date are only a copy', () => {
    const adopted = { xp: 50, streakDays: 99, lastActiveDate: '2026-01-01', awardedTaskIds: ['a'], activeDays: ['2026-10-04', '2026-10-05', '2026-10-06'] };
    expect(presentTreeState(adopted, NOW)).toMatchObject({ status: 'active', streakDays: 3, lastActiveDate: '2026-10-06', health: 'healthy', xp: 50 });
    // An empty history means no recorded activity, whatever the copy says.
    expect(presentTreeState({ ...adopted, activeDays: [] }, NOW)).toMatchObject({ status: 'unrecorded', streakDays: 0, lastActiveDate: null, health: 'dead' });
    expect(presentTreeState({ xp: 0, awardedTaskIds: [], activeDays: [] }, NOW)).toMatchObject({ status: 'unstarted' });
  });

  it('is deterministic: the same stored state and the same instant always give the same result', () => {
    expect(presentTreeState(stored, NOW)).toEqual(presentTreeState(structuredClone(stored), NOW));
  });
});

describe('replayAwardDays: the one recalculation (AC8: same award days -> same state)', () => {
  const today = '2026-10-08';

  it('gives the same result however the days are ordered or repeated', () => {
    const a = replayAwardDays(0, null, ['2026-10-06', '2026-10-07', today], today);
    const b = replayAwardDays(0, null, [today, '2026-10-07', '2026-10-06', '2026-10-06', '2026-10-07'], today);
    expect(a).toEqual({ streakDays: 3, lastActiveDate: today });
    expect(b).toEqual(a);
  });

  it('equals applying nextStreak one day at a time (one definition of the transition)', () => {
    let step: { streakDays: number; lastActiveDate: string | null } = { streakDays: 0, lastActiveDate: null };
    for (const day of ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06']) step = nextStreak(step.streakDays, step.lastActiveDate, day);
    expect(replayAwardDays(0, null, ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06'], '2026-10-06')).toEqual(step);
    expect(step).toEqual({ streakDays: 2, lastActiveDate: '2026-10-06' });
  });

  it('skips a day already covered by the stored date, but applies it when that date lies in the future (clock skew)', () => {
    expect(replayAwardDays(4, '2026-10-07', ['2026-10-05'], today)).toEqual({ streakDays: 4, lastActiveDate: '2026-10-07' });
    expect(replayAwardDays(4, '2026-10-09', [today], today)).toEqual({ streakDays: 4, lastActiveDate: today });
  });

  it('recovery: after any idle gap one award restores a healthy tree immediately', () => {
    for (const last of ['2026-10-04', '2026-10-01', '2026-01-01']) {
      const next = replayAwardDays(9, last, [today], today);
      expect(next).toEqual({ streakDays: 1, lastActiveDate: today });
      expect(deriveTreeStatus(next.streakDays, next.lastActiveDate, 90, today)).toMatchObject({ status: 'active', health: 'healthy', effectiveStreakDays: 1 });
    }
    // Yesterday is not a miss: the streak continues.
    expect(replayAwardDays(9, '2026-10-07', [today], today).streakDays).toBe(10);
  });

  it('property: for many random histories, the fold equals day-by-day nextStreak, in any order and with repeats', () => {
    let seed = 20261015;
    const random = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
    for (let run = 0; run < 300; run += 1) {
      const days = new Set<string>();
      const size = 1 + Math.floor(random() * 25);
      for (let i = 0; i < size; i += 1) days.add(new Date(Date.UTC(2026, 8, 1 + Math.floor(random() * 40))).toISOString().slice(0, 10));
      const ordered = [...days].sort();

      let step: { streakDays: number; lastActiveDate: string | null } = { streakDays: 0, lastActiveDate: null };
      for (const day of ordered) step = nextStreak(step.streakDays, step.lastActiveDate, day);

      const shuffled = [...ordered, ...ordered].sort(() => random() - 0.5);
      expect(replayAwardDays(0, null, shuffled, '2026-12-31')).toEqual(step);
    }
  });
});

describe('the retained history (Issue #16 AC8): activeDays', () => {
  const today = '2026-10-06';

  it('normalizeActiveDays keeps real dates, de-duplicated and oldest first; a non-array means "not adopted" (null)', () => {
    expect(normalizeActiveDays(['2026-10-07', '2026-10-05', '2026-10-07', 'junk', 7, '2026-02-30'])).toEqual(['2026-10-05', '2026-10-07']);
    expect(normalizeActiveDays([])).toEqual([]);
    for (const junk of [undefined, null, 'x', 5, {}, { $gt: 0 }]) expect(normalizeActiveDays(junk)).toBeNull();
  });

  describe('validateActiveDays: strict integrity of the STORED history (the award path never repairs it)', () => {
    const dayList = (count: number, from = '2000-01-01') => Array.from({ length: count }, (_, i) => new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10));

    it('absent (undefined / null) is a legacy tree, not an error', () => {
      expect(validateActiveDays(undefined)).toEqual({ status: 'absent' });
      expect(validateActiveDays(null)).toEqual({ status: 'absent' });
    });

    it('a valid array (any insertion order) is returned oldest first', () => {
      expect(validateActiveDays(['2026-10-06', '2026-10-04'])).toEqual({ status: 'valid', days: ['2026-10-04', '2026-10-06'] });
      expect(validateActiveDays([])).toEqual({ status: 'valid', days: [] });
      expect(validateActiveDays(dayList(ACTIVE_DAYS_MAX)).status).toBe('valid'); // exactly at the cap is fine
    });

    it.each([
      ['a string', 'junk'],
      ['a number', 5],
      ['an object', { $gt: 0 }],
      ['a boolean', true],
    ])('%s is malformed: not_an_array', (_label, raw) => {
      expect(validateActiveDays(raw)).toEqual({ status: 'malformed', reason: 'not_an_array' });
    });

    it.each([
      ['an unparsable string', ['2026-10-05', 'junk']],
      ['an impossible calendar date', ['2026-02-30']],
      ['a timestamp instead of a day', ['2026-10-05T00:00:00Z']],
      ['a non-string', ['2026-10-05', 7]],
      ['null', [null]],
      ['an empty string', ['']],
    ])('an entry that is %s is malformed: invalid_date (never silently dropped)', (_label, raw) => {
      expect(validateActiveDays(raw)).toEqual({ status: 'malformed', reason: 'invalid_date' });
    });

    it('the same day twice is malformed: duplicate_day (an $addToSet history cannot contain one)', () => {
      expect(validateActiveDays(['2026-10-05', '2026-10-06', '2026-10-05'])).toEqual({ status: 'malformed', reason: 'duplicate_day' });
    });

    it('an array already over the cap is malformed: over_cap (checked before scanning it)', () => {
      expect(validateActiveDays(dayList(ACTIVE_DAYS_MAX + 1))).toEqual({ status: 'malformed', reason: 'over_cap' });
      expect(validateActiveDays(new Array(ACTIVE_DAYS_MAX + 1).fill('junk'))).toEqual({ status: 'malformed', reason: 'over_cap' });
    });

    it('reads are lenient instead: normalizeActiveDays folds the valid, distinct entries in memory and never throws', () => {
      expect(normalizeActiveDays(['2026-10-05', 'junk', '2026-10-05', 7, '2026-10-06'])).toEqual(['2026-10-05', '2026-10-06']);
    });
  });

  describe('impliedStreakDays: only what a stored fold defensibly supports', () => {
    it('a streak of N ending on D is exactly N consecutive days; a date one day ahead (clock skew) counts as today', () => {
      expect(impliedStreakDays(3, '2026-10-05', today)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
      expect(impliedStreakDays(2, '2026-10-07', today)).toEqual(['2026-10-05', '2026-10-06']);
      expect(impliedStreakDays(2, today, today)).toEqual(['2026-10-05', '2026-10-06']);
      // Implied days replay to the very streak they came from (so adoption loses nothing).
      expect(replayAwardDays(0, null, impliedStreakDays(7, '2026-10-05', today) ?? [], today)).toEqual({ streakDays: 7, lastActiveDate: '2026-10-05' });
    });

    it('infers nothing from a zero (or negative) streak, even with a valid recent date', () => {
      for (const last of ['2026-10-05', today, '2026-01-01']) expect(impliedStreakDays(0, last, today)).toEqual([]);
      expect(impliedStreakDays(-3, '2026-10-05', today)).toEqual([]);
    });

    it('infers nothing without a valid last-active date', () => {
      expect(impliedStreakDays(4, null, today)).toEqual([]);
      expect(planLegacyAdoption({ streakDays: 4, lastActiveDate: 'junk' }, NOW)).toEqual([]);
      expect(planLegacyAdoption({ streakDays: 4, lastActiveDate: '2026-02-30' }, NOW)).toEqual([]);
      expect(planLegacyAdoption({ streakDays: 4 }, NOW)).toEqual([]);
    });

    it('infers nothing from a last-active date more than one day ahead (more than any clock skew explains)', () => {
      expect(impliedStreakDays(4, '2026-10-08', today)).toEqual([]); // two days ahead
      expect(impliedStreakDays(1e9, '2999-01-01', today)).toEqual([]); // a forged far-future date costs nothing
    });

    it('a streak the history cannot represent returns null (refuse, never shorten) and is rejected before any day is generated', () => {
      expect(impliedStreakDays(ACTIVE_DAYS_MAX + 1, '2026-10-05', today)).toBeNull();
      expect(impliedStreakDays(1e9, '2026-10-05', today)).toBeNull();
      expect(impliedStreakDays(ACTIVE_DAYS_MAX, '2026-10-05', today)).toHaveLength(ACTIVE_DAYS_MAX);
      // A streak that would run back before the first representable calendar date cannot be written as real dates either.
      expect(impliedStreakDays(5, '0100-01-02', today)).toBeNull();
      expect(impliedStreakDays(2, '0100-01-02', today)).toEqual(['0100-01-01', '0100-01-02']);
    });
  });

  describe('planLegacyAdoption: the COMPLETE set is validated before anything is written', () => {
    it('= implied streak days + valid legacy marker days, de-duplicated, oldest first', () => {
      const legacy = { streakDays: 2, lastActiveDate: '2026-10-04', pendingDerivedDays: ['2026-10-05', 'junk', '2026-10-04'] };
      expect(planLegacyAdoption(legacy, NOW)).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
      expect(planLegacyAdoption({}, NOW)).toEqual([]);
    });

    it('a combined set over the cap (streak days + marker days) cannot be adopted', () => {
      const markerDays = Array.from({ length: 1_500 }, (_, i) => new Date(Date.parse('1900-01-01') + i * 86_400_000).toISOString().slice(0, 10));
      const legacy = { streakDays: 19_000, lastActiveDate: '2026-10-05', pendingDerivedDays: markerDays };
      expect(impliedStreakDays(19_000, '2026-10-05', today)).toHaveLength(19_000); // each part fits on its own ...
      expect(planLegacyAdoption(legacy, NOW)).toBeNull(); // ... but 20,500 distinct days do not
    });

    it('overlap is counted once: marker days already inside the streak do not push the set over the cap', () => {
      const streak = impliedStreakDays(ACTIVE_DAYS_MAX - 1, '2026-10-05', today) ?? [];
      const legacy = { streakDays: ACTIVE_DAYS_MAX - 1, lastActiveDate: '2026-10-05', pendingDerivedDays: streak.slice(0, 500) };
      expect(planLegacyAdoption(legacy, NOW)).toHaveLength(ACTIVE_DAYS_MAX - 1);
    });

    it('reserves the slot for the day about to be awarded: a set that fills the cap leaves no room for a NEW day', () => {
      const full = { streakDays: ACTIVE_DAYS_MAX, lastActiveDate: '2026-10-05' }; // 20,000 days ending yesterday
      expect(planLegacyAdoption(full, NOW)).toHaveLength(ACTIVE_DAYS_MAX); // adoptable on its own (a reconcile)
      expect(planLegacyAdoption(full, NOW, today)).toBeNull(); // not when today must also be recorded
      const endsToday = { streakDays: ACTIVE_DAYS_MAX, lastActiveDate: today }; // today is already one of the 20,000
      expect(planLegacyAdoption(endsToday, NOW, today)).toHaveLength(ACTIVE_DAYS_MAX);
    });

    it('an unrepresentable streak is refused outright; a non-finite one is a value the normaliser already turns into "no streak"', () => {
      expect(planLegacyAdoption({ streakDays: 1e9, lastActiveDate: '2026-10-05' }, NOW)).toBeNull();
      expect(planLegacyAdoption({ streakDays: Number.MAX_SAFE_INTEGER, lastActiveDate: '2026-10-05' }, NOW)).toBeNull();
      expect(planLegacyAdoption({ streakDays: Infinity, lastActiveDate: '2026-10-05' }, NOW)).toEqual([]);
      expect(planLegacyAdoption({ streakDays: -5, lastActiveDate: '2026-10-05' }, NOW)).toEqual([]);
    });
  });

  it('effectiveFold: adopted = fold of the history from nothing; legacy = stored fold plus marker', () => {
    expect(effectiveFold({ streakDays: 9, lastActiveDate: '2026-10-05', activeDays: ['2026-10-05', '2026-10-06'] }, NOW)).toEqual({ streakDays: 2, lastActiveDate: today, adopted: true });
    expect(effectiveFold({ streakDays: 9, lastActiveDate: '2026-10-05' }, NOW)).toEqual({ streakDays: 9, lastActiveDate: '2026-10-05', adopted: false });
    expect(effectiveFold({ streakDays: 9, lastActiveDate: '2026-10-05', activeDays: 'junk' }, NOW).adopted).toBe(false);
  });

  it('needsReconcile: only when the stored copy differs from what the history says (adopted) or a legacy marker day waits', () => {
    const consistent = { streakDays: 2, lastActiveDate: today, activeDays: ['2026-10-05', today] };
    expect(needsReconcile(consistent, NOW)).toBe(false);
    expect(needsReconcile({ ...consistent, streakDays: 1 }, NOW)).toBe(true);
    expect(needsReconcile({ ...consistent, lastActiveDate: '2026-10-05' }, NOW)).toBe(true);
    expect(needsReconcile({ streakDays: 0, lastActiveDate: null, activeDays: [today] }, NOW)).toBe(true);
    expect(needsReconcile({ streakDays: 3, lastActiveDate: '2026-10-05' }, NOW)).toBe(false);
    expect(needsReconcile({ streakDays: 3, lastActiveDate: '2026-10-05', pendingDerivedDays: [today] }, NOW)).toBe(true);
    expect(needsReconcile({ streakDays: 3, lastActiveDate: '2026-10-05', pendingDerivedDays: ['junk'] }, NOW)).toBe(false);
  });
});

describe('normalising stored values (legacy / forged data is repaired, valid data is never reduced)', () => {
  it.each([
    ['Infinity', Infinity, 0],
    ['-Infinity', -Infinity, 0],
    ['NaN', NaN, 0],
    ['negative', -5, 0],
    ['a string', '9999', 0],
    ['null', null, 0],
    ['undefined', undefined, 0],
    ['an object', { $gt: 0 }, 0],
    ['a fraction (floored)', 12.9, 12],
    ['zero', 0, 0],
    ['a large but valid integer', 4_000_000, 4_000_000],
    ['MAX_SAFE_INTEGER', MAX_XP, MAX_XP],
    ['an unsafe integer (capped, never beyond exact range)', 2 ** 60, MAX_XP],
  ])('xp %s -> %s', (_label, raw, expected) => {
    expect(normalizeXp(raw)).toBe(expected);
    expect(normalizeStreakDays(raw)).toBe(expected);
  });

  it('keeps a valid date (even a future one) and drops anything that is not a real calendar date', () => {
    expect(normalizeLastActiveDate('2026-10-05')).toBe('2026-10-05');
    expect(normalizeLastActiveDate('2999-01-01')).toBe('2999-01-01');
    for (const junk of ['2026-02-30', 'tomorrow', '', 'y'.repeat(200_000), null, undefined, 20261005, {}]) {
      expect(normalizeLastActiveDate(junk)).toBeNull();
    }
  });

  it('accepts only plausible ledger ids', () => {
    expect(isValidAwardedTaskId('507f1f77bcf86cd799439011')).toBe(true);
    expect(isValidAwardedTaskId('local-1696-abc123')).toBe(true); // legacy offline ids are kept, they are harmless
    expect(isValidAwardedTaskId('x'.repeat(AWARDED_TASK_ID_MAX_LENGTH))).toBe(true);
    for (const bad of ['', 'x'.repeat(AWARDED_TASK_ID_MAX_LENGTH + 1), 42, null, undefined, {}, ['a']]) {
      expect(isValidAwardedTaskId(bad)).toBe(false);
    }
  });
});

describe('normalizePendingDays (the recovery marker)', () => {
  it('keeps real dates, de-duplicated and oldest first', () => {
    expect(normalizePendingDays(['2026-10-07', '2026-10-05', '2026-10-07', '2026-10-06'])).toEqual(['2026-10-05', '2026-10-06', '2026-10-07']);
  });

  it('ignores anything that is not an array, and any entry that is not a real calendar date', () => {
    for (const junk of [undefined, null, 'x', 5, {}, { $gt: 0 }, '2026-10-05']) expect(normalizePendingDays(junk)).toEqual([]);
    expect(normalizePendingDays(['garbage', 7, null, '2026-02-30', '2026-10-05T00:00:00Z', '2026-10-05'])).toEqual(['2026-10-05']);
  });
});

describe('normalizeTreeState', () => {
  it('derives leaves, stage and health from the authoritative inputs, ignoring the stored cache', () => {
    const state = normalizeTreeState(
      { xp: 130, leaves: 99999, stage: 'seed', health: 'dead', streakDays: 4, lastActiveDate: '2026-10-06', awardedTaskIds: ['a'] },
      NOW,
    );

    expect(state).toMatchObject({ xp: 130, leaves: 6, stage: 'mature', health: 'healthy', streakDays: 4, lastActiveDate: '2026-10-06' });
  });

  it('survives a missing or garbage tree (a user with no treeState yet)', () => {
    for (const raw of [undefined, null, 'x', 42, [], {}]) {
      expect(normalizeTreeState(raw, NOW)).toEqual({
        xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, health: 'dead', stage: 'seed',
        lastCalculatedAt: NOW.toISOString(), awardedTaskIds: [],
      });
    }
  });

  it('repairs forged numbers instead of passing them on, and never reduces valid XP', () => {
    const forged = normalizeTreeState({ xp: Infinity, streakDays: Infinity, leaves: Infinity, lastActiveDate: 'junk' }, NOW);
    expect(forged).toMatchObject({ xp: 0, streakDays: 0, leaves: 0, lastActiveDate: null });
    expect(JSON.parse(JSON.stringify(forged)).xp).toBe(0); // would have serialised as null before

    // 500 XP with an empty ledger (tasks since deleted) is legitimate history: kept as is.
    expect(normalizeTreeState({ xp: 500, awardedTaskIds: [] }, NOW).xp).toBe(500);
  });

  it('filters implausible ledger entries out of the RESPONSE without truncating the rest', () => {
    const ids = Array.from({ length: 1234 }, (_, i) => `id-${i}`);
    const state = normalizeTreeState({ xp: 10, awardedTaskIds: [...ids, '', 'x'.repeat(5000), 7, null] }, NOW);
    expect(state.awardedTaskIds).toEqual(ids);
  });

  it('keeps a valid timestamp, and replaces junk or missing ones with "now"', () => {
    expect(normalizeTreeState({ lastCalculatedAt: '2026-10-01T00:00:00.000Z' }, NOW).lastCalculatedAt).toBe('2026-10-01T00:00:00.000Z');
    for (const junk of ['not-a-date', '', 5, null, undefined]) {
      expect(normalizeTreeState({ lastCalculatedAt: junk }, NOW).lastCalculatedAt).toBe(NOW.toISOString());
    }
  });

  it('summarizeTree drops the ledger and nothing else', () => {
    const state = presentTreeState({ xp: 20, awardedTaskIds: ['a', 'b'] }, NOW);
    const summary = summarizeTree(state);
    expect(summary).not.toHaveProperty('awardedTaskIds');
    const { awardedTaskIds: _ledger, ...everythingElse } = state;
    expect(summary).toEqual(everythingElse);
  });
});
