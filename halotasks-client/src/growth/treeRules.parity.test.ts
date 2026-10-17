import { describe, expect, it, vi } from 'vitest';
import {
  TREE_STATUS_COPY,
  applyEffectiveStatus,
  awardXpForCompletion,
  createInitialTreeState,
  deriveTreeStatus,
  getHealthForStreak,
  getLeavesForXp,
  getStageForXp,
  getStreakHint,
  nextStreak,
} from './treeLogic';
import type { TreeState } from './treeTypes';

// Issue #24 — the client keeps its own copy of the display rules (preview and the stage bar); the server's
// halotasks-server/src/utils/treeRules.ts is the source of truth. These numbers are pinned identically in
// halotasks-server/tests/treeRules.test.ts, so changing one side without the other fails a test.
describe('tree display rules match the server', () => {
  it('+10 XP per completion', () => {
    const { state, event } = awardXpForCompletion(createInitialTreeState(), 't', true);
    expect(state.xp).toBe(10);
    expect(event?.xpGained).toBe(10);
  });

  it('1 leaf per 20 XP', () => {
    expect([0, 19, 20, 39, 40, 999].map(getLeavesForXp)).toEqual([0, 0, 1, 1, 2, 49]);
  });

  it('stage thresholds 0 / 20 / 60 / 120 / 250', () => {
    expect([0, 19, 20, 59, 60, 119, 120, 249, 250].map(getStageForXp)).toEqual([
      'seed', 'seed', 'sprout', 'sprout', 'young', 'young', 'mature', 'mature', 'lush',
    ]);
  });
});

// Issue #16 — PARITY TABLE: byte-identical to STATUS_CASES in halotasks-server/tests/treeRules.test.ts
// (the server decides; this copy only labels cached state and previews offline). Keep the two in sync.
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

describe('deriveTreeStatus matches the server rules', () => {
  const today = '2026-10-06';

  it.each(STATUS_CASES)('%s', (_label, streak, last, xp, status, effective, health, since) => {
    expect(deriveTreeStatus(streak, last, xp, today)).toEqual({ status, effectiveStreakDays: effective, health, daysSinceActive: since });
    expect(getHealthForStreak(streak, last, today)).toBe(health);
  });

  it('flips at UTC midnight and only at the documented thresholds', () => {
    const statusAt = (gap: number) => {
      const last = new Date(Date.UTC(2026, 9, 6) - gap * 86_400_000).toISOString().split('T')[0];
      return deriveTreeStatus(5, last, 50, today).status;
    };
    const seen: string[] = [];
    for (let gap = -3; gap <= 40; gap += 1) seen.push(statusAt(gap));
    expect(seen.slice(0, 4)).toEqual(['active', 'active', 'active', 'active']);
    expect(seen[4]).toBe('at_risk');
    expect(seen[5]).toBe('wilting');
    expect(new Set(seen.slice(6))).toEqual(new Set(['dead']));
  });
});

describe('nextStreak matches the server rule (same rows as halotasks-server/tests/treeRules.test.ts)', () => {
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

describe('display copy and invariants (Issue #16)', () => {
  const base = (over: Partial<TreeState>): TreeState => ({ ...createInitialTreeState(), ...over });

  it('every status has copy, and none of it says or implies XP, leaves or stage were lost', () => {
    const statuses = ['unstarted', 'active', 'at_risk', 'wilting', 'dead', 'unrecorded'] as const;
    expect(Object.keys(TREE_STATUS_COPY).sort()).toEqual([...statuses].sort());
    for (const status of statuses) {
      expect(TREE_STATUS_COPY[status].message).not.toMatch(/\b(lost|lose|reset to 0|deleted|removed)\b/i);
    }
    for (const status of ['wilting', 'dead', 'unrecorded'] as const) {
      expect(TREE_STATUS_COPY[status].message).toMatch(/XP/);
      expect(TREE_STATUS_COPY[status].message).toMatch(/safe/);
    }
  });

  it('streak hints: today, yesterday, n days, none before the first completion', () => {
    const hint = (streak: number, last: string | null, xp: number) => getStreakHint(deriveTreeStatus(streak, last, xp, '2026-10-06'));
    expect(hint(3, '2026-10-06', 30)).toBe('Active Today');
    expect(hint(3, '2026-10-05', 30)).toBe('Last active yesterday');
    expect(hint(3, '2026-10-03', 30)).toBe('3d since last');
    expect(hint(0, null, 0)).toBeNull();
  });

  it('applyEffectiveStatus changes only streak and health, never xp, leaves, stage, ledger or date', () => {
    const state = base({ xp: 130, leaves: 6, stage: 'mature', streakDays: 7, lastActiveDate: '2026-10-01', health: 'healthy', awardedTaskIds: new Set(['a']) });
    const shown = applyEffectiveStatus(state, '2026-10-06');
    expect(shown).toMatchObject({ xp: 130, leaves: 6, stage: 'mature', streakDays: 0, health: 'dead', lastActiveDate: '2026-10-01' });
    expect([...shown.awardedTaskIds]).toEqual(['a']);
    expect(state.streakDays).toBe(7); // input untouched
    expect(applyEffectiveStatus(shown, '2026-10-06')).toBe(shown); // idempotent on an already-effective state
  });

  it('offline preview: a completion after idle days restarts at 1 and is healthy; yesterday continues', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
      const idle = awardXpForCompletion(base({ xp: 40, streakDays: 0, lastActiveDate: '2026-10-01', health: 'dead' }), 't', true).state;
      expect(idle).toMatchObject({ xp: 50, streakDays: 1, health: 'healthy', lastActiveDate: '2026-10-06' });
      const next = awardXpForCompletion(base({ xp: 40, streakDays: 4, lastActiveDate: '2026-10-05', health: 'healthy' }), 't', true).state;
      expect(next).toMatchObject({ streakDays: 5, health: 'healthy' });
    } finally {
      vi.useRealTimers();
    }
  });
});
