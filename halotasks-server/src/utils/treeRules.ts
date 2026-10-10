import { isValidCalendarDate } from './calendarDate';

// ── Growth Tree rules (Issue #24) ───────────────────────────────────────────────
//
// The ONE place the server decides what a Growth Tree means. Everything here is pure (no I/O, no
// clock: callers pass `now`), so the rules are testable on their own and Issue #16 can change the
// streak/health rules in this file without touching controllers or storage.
//
// These are the SAME rules the client has always run (halotasks-client/src/growth/treeLogic.ts):
// +10 XP per completed task, +1 leaf per 20 XP, the same stage thresholds, the same streak and
// health rules on the UTC calendar day. The client keeps a copy only to preview an offline
// completion; a parity test on each side pins the shared numbers.
//
// Field authority (see docs/context.md, "Growth Tree integrity model"):
//   xp, awardedTaskIds ........ server-authoritative; change ONLY through the atomic award
//   streakDays, lastActiveDate  server-authoritative; advanced by the award, UTC rule
//   lastCalculatedAt .......... server-stamped
//   leaves, stage, health ..... derived (from xp / streak / date); every read recomputes them
//
// Legacy data: stored values are NEVER reduced because of how many task ids are recorded (XP may
// legitimately outlive deleted tasks). Only structurally impossible values are repaired (in responses by normalizeTreeState, in storage only by the
// award, never by a read): not a
// number, non-finite, negative, fractional (floored) or beyond the safe-integer range (capped).

export type TreeHealth = 'healthy' | 'wilting' | 'dead';
export type TreeStage = 'seed' | 'sprout' | 'young' | 'mature' | 'lush';

export const XP_PER_COMPLETION = 10;
export const XP_PER_LEAF = 20;

export const STAGE_THRESHOLDS: Record<TreeStage, number> = {
  seed: 0,
  sprout: 20,
  young: 60,
  mature: 120,
  lush: 250,
};
const STAGE_ORDER: TreeStage[] = ['seed', 'sprout', 'young', 'mature', 'lush'];

/**
 * Upper bound on the awarded-task-id ledger. At ~26 bytes per id this keeps the embedded array far
 * below MongoDB's 16 MB document limit. The ledger is never truncated: once it is full, further
 * awards are refused (reason 'ledger_full') rather than forgetting an id, which would allow a replay.
 */
export const AWARDED_TASK_IDS_MAX = 20_000;
export const AWARDED_TASK_ID_MAX_LENGTH = 64;

/** XP stays an exact integer: an award is refused (reason 'xp_ceiling') rather than lose precision. */
export const MAX_XP = Number.MAX_SAFE_INTEGER;

/** Fields a client may never write (PATCH /api/tree answers 400 TREE_FIELD_NOT_WRITABLE for any of them). */
export const TREE_REWARD_FIELDS = [
  'xp',
  'leaves',
  'streakDays',
  'lastActiveDate',
  'health',
  'stage',
  'lastCalculatedAt',
  'awardedTaskIds',
] as const;

export type TreeSummary = {
  xp: number;
  leaves: number;
  streakDays: number;
  lastActiveDate: string | null;
  health: TreeHealth;
  stage: TreeStage;
  lastCalculatedAt: string;
};

/** What GET /api/tree returns: the summary plus the (validated) dedupe ledger, as before. */
export type TreeState = TreeSummary & { awardedTaskIds: string[] };

export type GrowthResult = {
  taskId: string;
  awarded: boolean;
  xpGained: number;
  /** Present only when `awarded` is false. */
  reason?: 'already_awarded' | 'ledger_full' | 'xp_ceiling';
  treeState: TreeSummary;
};

// ── Calendar (UTC, as today) ────────────────────────────────────────────────────

/** Current date as YYYY-MM-DD in UTC — the existing Growth Tree day boundary (Issue #16 may change it). */
export const getTodayUtc = (now: Date): string => now.toISOString().split('T')[0];

/** Whole days from dateA to dateB (YYYY-MM-DD). 0 when dateA is null. Identical to the client's. */
export const daysBetween = (dateA: string | null, dateB: string): number => {
  if (!dateA) return 0;
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.floor((b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
};

// ── Derivations ─────────────────────────────────────────────────────────────────

export const getStageForXp = (xp: number): TreeStage => {
  for (let i = STAGE_ORDER.length - 1; i >= 0; i--) {
    if (xp >= STAGE_THRESHOLDS[STAGE_ORDER[i]]) return STAGE_ORDER[i];
  }
  return 'seed';
};

export const getLeavesForXp = (xp: number): number => Math.floor(xp / XP_PER_LEAF);

export const getHealthForStreak = (
  streakDays: number,
  lastActiveDate: string | null,
  today: string,
): TreeHealth => {
  const daysSinceActive = daysBetween(lastActiveDate, today);

  if (streakDays === 0) return 'dead';
  if (daysSinceActive === 0 || daysSinceActive === 1) return 'healthy';
  if (daysSinceActive === 2) return 'wilting';
  return 'dead';
};

/**
 * The streak transition applied when a task is awarded today (the existing client rule, unchanged):
 *   same day            -> nothing changes
 *   yesterday           -> streak + 1
 *   2+ days ago         -> streak restarts at 1
 *   no previous activity-> streak 1
 *   a date in the future / unparsable gap -> streak unchanged (only the date moves to today)
 */
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

// ── Normalisation of stored values (legacy / forged data) ───────────────────────

/** A finite, non-negative integer within the safe range; anything else becomes 0 (fractions are floored). */
const toCount = (raw: unknown): number => {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return 0;
  return Math.min(Math.floor(raw), MAX_XP);
};

export const normalizeXp = (raw: unknown): number => toCount(raw);
export const normalizeStreakDays = (raw: unknown): number => toCount(raw);

/** A real calendar date or null. A valid date in the future is kept (see nextStreak). */
export const normalizeLastActiveDate = (raw: unknown): string | null =>
  isValidCalendarDate(raw) ? raw : null;

/**
 * The award days recorded in the recovery marker (`treeState.pendingDerivedDays`): real calendar dates only,
 * de-duplicated, oldest first. Anything that is not an array, and any entry that is not a real date, is
 * ignored (the marker is server-written, but it is still read defensively).
 */
export const normalizePendingDays = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return [];
  const days = new Set<string>();
  for (const entry of raw) {
    if (isValidCalendarDate(entry)) days.add(entry);
  }
  return [...days].sort();
};

export const isValidAwardedTaskId = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= AWARDED_TASK_ID_MAX_LENGTH;

const normalizeTimestamp = (raw: unknown, now: Date): string => {
  if (typeof raw === 'string') {
    const ms = Date.parse(raw);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return now.toISOString();
};

const asRecord = (raw: unknown): Record<string, unknown> =>
  typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

/**
 * Turns whatever is stored into a well-formed state. Never trusts the stored shape: xp/streak are
 * repaired as above, leaves/stage/health are DERIVED (the stored copies are only a cache), and
 * ledger entries that are not plausible ids are left out of the RESPONSE (storage is not touched,
 * and nothing is truncated). This function only computes; it never writes.
 */
export const normalizeTreeState = (raw: unknown, now: Date): TreeState => {
  const stored = asRecord(raw);
  const today = getTodayUtc(now);

  const xp = normalizeXp(stored.xp);
  const streakDays = normalizeStreakDays(stored.streakDays);
  const lastActiveDate = normalizeLastActiveDate(stored.lastActiveDate);
  const ledger = Array.isArray(stored.awardedTaskIds) ? stored.awardedTaskIds : [];

  return {
    xp,
    leaves: getLeavesForXp(xp),
    streakDays,
    lastActiveDate,
    health: getHealthForStreak(streakDays, lastActiveDate, today),
    stage: getStageForXp(xp),
    lastCalculatedAt: normalizeTimestamp(stored.lastCalculatedAt, now),
    awardedTaskIds: ledger.filter(isValidAwardedTaskId),
  };
};

export const summarizeTree = ({ awardedTaskIds: _ledger, ...summary }: TreeState): TreeSummary => summary;
