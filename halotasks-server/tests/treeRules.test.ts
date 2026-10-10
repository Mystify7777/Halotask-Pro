import { describe, expect, it } from 'vitest';
import {
  AWARDED_TASK_IDS_MAX,
  AWARDED_TASK_ID_MAX_LENGTH,
  MAX_XP,
  STAGE_THRESHOLDS,
  TREE_REWARD_FIELDS,
  XP_PER_COMPLETION,
  XP_PER_LEAF,
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

describe('getHealthForStreak: the existing rule, unchanged', () => {
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
    const state = normalizeTreeState({ xp: 20, awardedTaskIds: ['a', 'b'] }, NOW);
    const summary = summarizeTree(state);
    expect(summary).not.toHaveProperty('awardedTaskIds');
    const { awardedTaskIds: _ledger, ...everythingElse } = state;
    expect(summary).toEqual(everythingElse);
  });
});
