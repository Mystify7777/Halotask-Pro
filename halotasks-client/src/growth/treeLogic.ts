/**
 * Growth Tree Logic Engine
 * 
 * Pure functions for growth calculations.
 * No side effects, fully testable.
 */

import { TreeState, TreeHealth, TreeStage, GrowthEventPayload } from './treeTypes';

const XP_PER_COMPLETION = 10;
const XP_PER_LEAF = 20;

// XP thresholds for tree stages
const STAGE_THRESHOLDS: Record<TreeStage, number> = {
  seed: 0,
  sprout: 20,
  young: 60,
  mature: 120,
  lush: 250,
};

const STAGE_ORDER: TreeStage[] = ['seed', 'sprout', 'young', 'mature', 'lush'];

export type StageProgress = {
  currentStage: TreeStage;
  nextStage: TreeStage | null;
  currentThreshold: number;
  nextThreshold: number;
  progressPercent: number;
};

/**
 * Get current date as YYYY-MM-DD
 */
export const getTodayDate = (): string => {
  const today = new Date();
  return today.toISOString().split('T')[0];
};

/**
 * Calculate days between two dates (YYYY-MM-DD format)
 */
export const daysBetween = (dateA: string | null, dateB: string): number => {
  if (!dateA) return 0;
  const a = new Date(dateA);
  const b = new Date(dateB);
  const diffMs = b.getTime() - a.getTime();
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
};

/**
 * Determine tree stage based on xp
 */
export const getStageForXp = (xp: number): TreeStage => {
  for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
    const stage = STAGE_ORDER[i];
    if (xp >= STAGE_THRESHOLDS[stage]) {
      return stage;
    }
  }
  return 'seed';
};

/**
 * Get stage-relative progress details for a given XP value.
 *
 * Progress is calculated within the current stage range:
 * (xp - currentThreshold) / (nextThreshold - currentThreshold)
 */
export const getStageProgressForXp = (xp: number): StageProgress => {
  const currentStage = getStageForXp(xp);
  const currentIndex = STAGE_ORDER.indexOf(currentStage);
  const nextStage = currentIndex < STAGE_ORDER.length - 1 ? STAGE_ORDER[currentIndex + 1] : null;
  const currentThreshold = STAGE_THRESHOLDS[currentStage];

  if (!nextStage) {
    return {
      currentStage,
      nextStage: null,
      currentThreshold,
      nextThreshold: currentThreshold,
      progressPercent: 100,
    };
  }

  const nextThreshold = STAGE_THRESHOLDS[nextStage];
  const stageSpan = nextThreshold - currentThreshold;

  if (stageSpan <= 0) {
    return {
      currentStage,
      nextStage,
      currentThreshold,
      nextThreshold,
      progressPercent: 100,
    };
  }

  const rawPercent = ((xp - currentThreshold) / stageSpan) * 100;
  const progressPercent = Math.max(0, Math.min(rawPercent, 100));

  return {
    currentStage,
    nextStage,
    currentThreshold,
    nextThreshold,
    progressPercent,
  };
};

/**
 * Calculate leaves earned from xp
 */
export const getLeavesForXp = (xp: number): number => {
  return Math.floor(xp / XP_PER_LEAF);
};

/**
 * Calculate health based on streak
 */
export const getHealthForStreak = (streakDays: number, lastActiveDate: string | null): TreeHealth => {
  const today = getTodayDate();
  const daysSinceActive = daysBetween(lastActiveDate, today);

  // If no activity recorded, tree is dead
  if (streakDays === 0) {
    return 'dead';
  }

  // If completed task today or yesterday, healthy
  if (daysSinceActive === 0 || daysSinceActive === 1) {
    return 'healthy';
  }

  // If missed 1 day (2 days since last activity), wilting
  if (daysSinceActive === 2) {
    return 'wilting';
  }

  // If missed 3+ days, dead
  return 'dead';
};

/**
 * Process streak logic on each load
 * 
 * Called when app initializes to check if streak continues or resets
 */
export const updateStreakState = (state: TreeState): TreeState => {
  const today = getTodayDate();
  const daysSinceActive = daysBetween(state.lastActiveDate, today);

  // If no last activity, streak stays at 0
  if (!state.lastActiveDate) {
    return {
      ...state,
      streakDays: 0,
      health: 'dead',
      lastCalculatedAt: new Date().toISOString(),
    };
  }

  // If completed task today, streak continues
  if (daysSinceActive === 0) {
    return state;
  }

  // If missed exactly 1 day (2 days since last), streak resets but health wilts
  if (daysSinceActive === 2) {
    return {
      ...state,
      health: 'wilting',
      lastCalculatedAt: new Date().toISOString(),
    };
  }

  // If missed 2+ days (3+ days since last), streak resets to 0
  if (daysSinceActive >= 3) {
    return {
      ...state,
      streakDays: 0,
      health: 'dead',
      lastCalculatedAt: new Date().toISOString(),
    };
  }

  return state;
};

/**
 * Award XP for task completion
 * 
 * Only awards if:
 * 1. Task completed (not uncompleted)
 * 2. Never awarded before (prevents double-dipping on re-completes)
 * 3. This is the first real completion in this session
 * 
 * Returns updated state and event payload for UI feedback
 */
export const awardXpForCompletion = (
  state: TreeState,
  taskId: string,
  isCompletion: boolean,
): { state: TreeState; event: GrowthEventPayload | null } => {
  // Only reward incomplete → complete transitions
  if (!isCompletion) {
    return { state, event: null };
  }

  // Only reward once per task
  if (state.awardedTaskIds.has(taskId)) {
    return { state, event: null };
  }

  const previousXp = state.xp;
  const newXp = state.xp + XP_PER_COMPLETION;
  const newLeaves = getLeavesForXp(newXp);
  const newStage = getStageForXp(newXp);

  // Update streak if completing on new day
  const today = getTodayDate();
  let newStreakDays = state.streakDays;
  let newLastActiveDate = state.lastActiveDate;

  if (state.lastActiveDate !== today) {
    // User completing first task of the day
    if (state.lastActiveDate) {
      // Check if they missed days
      const daysSinceActive = daysBetween(state.lastActiveDate, today);
      if (daysSinceActive === 1) {
        // Completed yesterday, streak continues
        newStreakDays = state.streakDays + 1;
      } else if (daysSinceActive > 1) {
        // Missed days, streak resets
        newStreakDays = 1;
      }
    } else {
      // First ever completion
      newStreakDays = 1;
    }
    newLastActiveDate = today;
  }

  const newHealth = getHealthForStreak(newStreakDays, newLastActiveDate);
  const healthChanged = state.health !== newHealth;

  const newAwardedIds = new Set(state.awardedTaskIds);
  newAwardedIds.add(taskId);

  const updatedState: TreeState = {
    xp: newXp,
    leaves: newLeaves,
    streakDays: newStreakDays,
    lastActiveDate: newLastActiveDate,
    health: newHealth,
    stage: newStage,
    lastCalculatedAt: new Date().toISOString(),
    awardedTaskIds: newAwardedIds,
  };

  const event: GrowthEventPayload = {
    taskId,
    previousXp,
    currentXp: newXp,
    xpGained: XP_PER_COMPLETION,
    newLeaves,
    newStage,
    healthChanged,
  };

  return { state: updatedState, event };
};

/**
 * Initialize fresh tree state
 */
export const createInitialTreeState = (): TreeState => {
  return {
    xp: 0,
    leaves: 0,
    streakDays: 0,
    lastActiveDate: null,
    health: 'dead',
    stage: 'seed',
    lastCalculatedAt: new Date().toISOString(),
    awardedTaskIds: new Set(),
  };
};

/**
 * Get human-readable stage description
 */
export const getStageDescription = (stage: TreeStage): string => {
  const descriptions: Record<TreeStage, string> = {
    seed: 'Seed',
    sprout: 'Sprout',
    young: 'Young Tree',
    mature: 'Mature Tree',
    lush: 'Lush Tree',
  };
  return descriptions[stage];
};

/**
 * Get stage emoji/icon
 */
export const getStageEmoji = (stage: TreeStage): string => {
  const emojis: Record<TreeStage, string> = {
    seed: '🌱',
    sprout: '🌿',
    young: '🌳',
    mature: '🌲',
    lush: '🌴',
  };
  return emojis[stage];
};
