/**
 * Growth Tree Logic Engine
 * 
 * Pure functions for growth calculations.
 * No side effects, fully testable.
 */

import { TreeState, TreeHealth, TreeStage, TreeStatus, GrowthEventPayload } from './treeTypes';

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
  xpToNextStage: number;
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
      xpToNextStage: 0,
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
      xpToNextStage: 0,
    };
  }

  const rawPercent = ((xp - currentThreshold) / stageSpan) * 100;
  const progressPercent = Math.max(0, Math.min(rawPercent, 100));
  const xpToNextStage = Math.max(nextThreshold - xp, 0);

  return {
    currentStage,
    nextStage,
    currentThreshold,
    nextThreshold,
    progressPercent,
    xpToNextStage,
  };
};

/**
 * Calculate leaves earned from xp
 */
export const getLeavesForXp = (xp: number): number => {
  return Math.floor(xp / XP_PER_LEAF);
};

/**
 * Reset / health / recovery rules (Issue #16) — a NON-AUTHORITATIVE copy of
 * halotasks-server/src/utils/treeRules.ts `deriveTreeStatus`, used only to label the cached state and to
 * preview an offline completion. halotasks-client/src/growth/treeRules.parity.test.ts holds the same case
 * table as the server's test, so the two cannot drift silently. Conditions are exclusive, in this order:
 *   unstarted  no date, xp 0                      streak 0   dead
 *   unrecorded no date but xp > 0                  streak 0   dead
 *   dead       2+ missed days  (gap >= 3)          streak 0   dead
 *   wilting    1 missed day    (gap === 2)         streak 0   wilting
 *   unrecorded gap <= 1 but a stored streak of 0   streak 0   dead   (legacy)
 *   at_risk    last completion yesterday (gap 1)   stored     healthy
 *   active     completed today (gap <= 0)          stored     healthy
 * XP, leaves and stage are never part of this. The day is the UTC calendar day.
 */
export type TreeStatusInfo = {
  status: TreeStatus;
  effectiveStreakDays: number;
  health: TreeHealth;
  daysSinceActive: number | null;
};

export const deriveTreeStatus = (
  streakDays: number,
  lastActiveDate: string | null,
  xp: number,
  today: string = getTodayDate(),
): TreeStatusInfo => {
  if (!lastActiveDate) {
    return { status: xp === 0 ? 'unstarted' : 'unrecorded', effectiveStreakDays: 0, health: 'dead', daysSinceActive: null };
  }
  const gap = Math.max(0, daysBetween(lastActiveDate, today));
  if (gap >= 3) return { status: 'dead', effectiveStreakDays: 0, health: 'dead', daysSinceActive: gap };
  if (gap === 2) return { status: 'wilting', effectiveStreakDays: 0, health: 'wilting', daysSinceActive: gap };
  if (streakDays === 0) return { status: 'unrecorded', effectiveStreakDays: 0, health: 'dead', daysSinceActive: gap };
  return { status: gap === 1 ? 'at_risk' : 'active', effectiveStreakDays: streakDays, health: 'healthy', daysSinceActive: gap };
};

/** Health alone; the same rule as deriveTreeStatus. */
export const getHealthForStreak = (
  streakDays: number,
  lastActiveDate: string | null,
  today: string = getTodayDate(),
): TreeHealth => deriveTreeStatus(streakDays, lastActiveDate, 1, today).health;

/** The streak transition of an award on `today` (same rule as the server's nextStreak). */
export const nextStreak = (
  streakDays: number,
  lastActiveDate: string | null,
  today: string,
): { streakDays: number; lastActiveDate: string } => {
  if (lastActiveDate === today) return { streakDays, lastActiveDate: today };
  let next = streakDays;
  if (lastActiveDate) {
    const gap = daysBetween(lastActiveDate, today);
    if (gap === 1) next = streakDays + 1;
    else if (gap > 1) next = 1;
  } else {
    next = 1;
  }
  return { streakDays: next, lastActiveDate: today };
};

/**
 * Show the cached state as of today: effective streak and health only. xp, leaves, stage and the ledger are
 * returned untouched, and nothing is written anywhere. Idempotent, so applying it to a state the server has
 * already presented changes nothing.
 */
export const applyEffectiveStatus = (state: TreeState, today: string = getTodayDate()): TreeState => {
  const info = deriveTreeStatus(state.streakDays, state.lastActiveDate, state.xp, today);
  if (info.effectiveStreakDays === state.streakDays && info.health === state.health) return state;
  return { ...state, streakDays: info.effectiveStreakDays, health: info.health, lastCalculatedAt: new Date().toISOString() };
};

/**
 * Display copy for each status. Never says or implies that XP, leaves or stage were lost.
 */
export const TREE_STATUS_COPY: Record<TreeStatus, { healthLabel: string; message: string }> = {
  unstarted: { healthLabel: '—', message: 'Complete your first task to plant a seed.' },
  active: { healthLabel: 'Healthy', message: 'You grew your tree today. Come back tomorrow to keep the streak going.' },
  at_risk: { healthLabel: 'Healthy', message: 'Complete a task today to keep your streak going.' },
  wilting: {
    healthLabel: 'Wilting',
    message: 'You missed a day, so the streak reset and the tree is wilting. Your XP and stage are safe. Complete a task to restore it.',
  },
  dead: {
    healthLabel: 'Needs Care',
    message: 'It has been a few days, so the streak reset. Your XP, leaves and stage are safe. Complete a task to bring your tree back.',
  },
  unrecorded: { healthLabel: 'Needs Care', message: 'Complete a task to start a new streak. Your XP and stage are safe.' },
};

/** Hint under the streak counter. */
export const getStreakHint = (info: TreeStatusInfo): string | null => {
  if (info.status === 'unstarted') return null;
  if (info.daysSinceActive === null) return null;
  if (info.daysSinceActive === 0) return 'Active Today';
  if (info.daysSinceActive === 1) return 'Last active yesterday';
  return `${info.daysSinceActive}d since last`;
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

  // Streak: the shared rule (continues after a completion yesterday, otherwise restarts at 1).
  const today = getTodayDate();
  const { streakDays: newStreakDays, lastActiveDate: newLastActiveDate } = nextStreak(state.streakDays, state.lastActiveDate, today);

  const newHealth = getHealthForStreak(newStreakDays, newLastActiveDate, today);
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
