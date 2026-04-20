/**
 * Growth Tree Type Definitions
 * 
 * Minimal, clean data model for tracking user progress through task completion.
 * Designed for longevity and sustainable engagement.
 */

export type TreeHealth = 'healthy' | 'wilting' | 'dead';
export type TreeStage = 'seed' | 'sprout' | 'young' | 'mature' | 'lush';

/**
 * TreeState: Core growth tracking
 * 
 * Values persist locally and sync to backend eventually.
 * Prevent exploitation: only reward incomplete → complete transitions.
 */
export interface TreeState {
  /** Experience points from completed tasks (+10 per completion) */
  xp: number;

  /** Cosmetic leaves earned (+1 per 20 xp) */
  leaves: number;

  /** Consecutive days with at least one task completed */
  streakDays: number;

  /** Last date user completed a task (YYYY-MM-DD format) */
  lastActiveDate: string | null;

  /** Tree health based on streak consistency */
  health: TreeHealth;

  /** Tree growth stage based on xp thresholds */
  stage: TreeStage;

  /** Timestamp of last state calculation (ISO string) */
  lastCalculatedAt: string;

  /** Set of task IDs already awarded xp (prevents double-rewards on re-completes) */
  awardedTaskIds: Set<string>;
}

/**
 * TreeStateWithoutSets: Serializable version for storage/API
 * 
 * Convert TreeState to this for JSON storage
 */
export interface TreeStateJSON {
  xp: number;
  leaves: number;
  streakDays: number;
  lastActiveDate: string | null;
  health: TreeHealth;
  stage: TreeStage;
  lastCalculatedAt: string;
  awardedTaskIds: string[];
}

/**
 * Growth event: fired when user completes task
 */
export interface GrowthEventPayload {
  taskId: string;
  previousXp: number;
  currentXp: number;
  xpGained: number;
  newLeaves: number;
  newStage: TreeStage;
  healthChanged: boolean;
}
