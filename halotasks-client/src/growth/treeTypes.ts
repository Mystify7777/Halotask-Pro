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
 * The SERVER is authoritative (Issue #24): xp and awardedTaskIds only ever change when the server
 * awards a task completion, and every other field is derived from them. The client keeps a cache of
 * the last server-confirmed state (and, offline, a display-only preview that is never persisted or sent).
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
 * The tree as the server returns it inside a task response: everything except the ledger.
 */
export type TreeSummaryJSON = Omit<TreeStateJSON, 'awardedTaskIds'>;

/**
 * `growth` block added to POST/PUT /api/tasks responses when a completion was processed (Issue #24).
 * `awarded:false` means the server already had (or could not take) an award for this task; `treeState`
 * is still the server's current truth and is applied either way.
 */
export interface GrowthResult {
  taskId: string;
  awarded: boolean;
  xpGained: number;
  reason?: 'already_awarded' | 'ledger_full' | 'xp_ceiling';
  treeState: TreeSummaryJSON;
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
