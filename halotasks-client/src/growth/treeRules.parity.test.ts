import { describe, expect, it } from 'vitest';
import { awardXpForCompletion, createInitialTreeState, getLeavesForXp, getStageForXp } from './treeLogic';

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
