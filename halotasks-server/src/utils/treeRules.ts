import { addDays, isValidCalendarDate } from './calendarDate';

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

/**
 * Upper bound on the retained award-day history (`treeState.activeDays`, Issue #16 AC8). It holds at most one
 * entry per UTC calendar day, so 20,000 entries are about 55 years of daily activity and ~220 KB. Like the
 * ledger it is NEVER truncated: a day that would not fit is refused (reason 'history_full') rather than
 * dropping an old day, because a silently shortened history would make recalculation give a different answer.
 */
export const ACTIVE_DAYS_MAX = 20_000;

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

export type TreeStatus = 'unstarted' | 'active' | 'at_risk' | 'wilting' | 'dead' | 'unrecorded';

/** The stored fold plus derived cache fields. `streakDays` here is the STORED streak (see presentTreeState). */
export type TreeBase = {
  xp: number;
  leaves: number;
  streakDays: number;
  lastActiveDate: string | null;
  health: TreeHealth;
  stage: TreeStage;
  lastCalculatedAt: string;
};

/** What the API returns for a tree: `streakDays`/`health` are EFFECTIVE (Issue #16), plus `status`. */
export type TreeSummary = TreeBase & {
  status: TreeStatus;
  /** Whole UTC days since the last completion; null when there has never been one. Never negative. */
  daysSinceActive: number | null;
};

/** The stored fold with its validated ledger. Internal: the award path folds on this. */
export type TreeState = TreeBase & { awardedTaskIds: string[] };

/** What GET /api/tree returns: the effective summary plus the (validated) dedupe ledger, as before. */
export type PresentedTree = TreeSummary & { awardedTaskIds: string[] };

export type GrowthResult = {
  taskId: string;
  awarded: boolean;
  xpGained: number;
  /** Present only when `awarded` is false. */
  reason?: 'already_awarded' | 'ledger_full' | 'xp_ceiling' | 'history_full';
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

// ── Reset, health and recovery rules (Issue #16) ────────────────────────────────
//
// The ONE definition. `lastActiveDate` is the last UTC day a completion was awarded; `gap` is the number
// of whole UTC days from it to today. The status conditions below are exclusive and evaluated in order.
//
//   status      condition                                  effective streak  health
//   unstarted   no last-active date and xp === 0           0                 dead
//   unrecorded  no last-active date but xp > 0           0                 dead
//   dead        gap >= 3  (two or more missed days)         0                 dead
//   wilting     gap === 2 (one missed day)                  0                 wilting
//   unrecorded  gap <= 1 but a stored streak of 0 (legacy)  0                 dead
//   at_risk     gap === 1 (today still open)                stored streak     healthy
//   active      gap <= 0  (done today; a future date too)   stored streak     healthy
//
// The missed-day thresholds come first: a legacy zero-streak record that is 2 or 3+ days old is wilting /
// dead like any other idle tree. `unrecorded` is only for a record that looks current but has no streak.
//
// Recovery: one award on any day sets the date to that day, so the very next derivation is `active`
// (healthy). The award itself (nextStreak) continues the stored streak only when gap === 1 and otherwise
// restarts it at 1. XP, leaves and stage are never touched by any of this. Reads derive; they never write.
// The calendar day is UTC (documented limitation: see docs/context.md).

/** Days without a completion at which the tree starts wilting / is dead. */
export const WILTING_AFTER_DAYS = 2;
export const DEAD_AFTER_DAYS = 3;

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
  today: string,
): TreeStatusInfo => {
  if (lastActiveDate === null) {
    return { status: xp === 0 ? 'unstarted' : 'unrecorded', effectiveStreakDays: 0, health: 'dead', daysSinceActive: null };
  }
  const gap = Math.max(0, daysBetween(lastActiveDate, today));
  if (gap >= DEAD_AFTER_DAYS) return { status: 'dead', effectiveStreakDays: 0, health: 'dead', daysSinceActive: gap };
  if (gap >= WILTING_AFTER_DAYS) return { status: 'wilting', effectiveStreakDays: 0, health: 'wilting', daysSinceActive: gap };
  if (streakDays === 0) return { status: 'unrecorded', effectiveStreakDays: 0, health: 'dead', daysSinceActive: gap };
  return { status: gap === 1 ? 'at_risk' : 'active', effectiveStreakDays: streakDays, health: 'healthy', daysSinceActive: gap };
};

/** Health alone (kept for callers that only need it). Same rule as deriveTreeStatus; xp is irrelevant to health. */
export const getHealthForStreak = (
  streakDays: number,
  lastActiveDate: string | null,
  today: string,
): TreeHealth => deriveTreeStatus(streakDays, lastActiveDate, 1, today).health;

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

/**
 * Folds award days into a starting streak, oldest first. This is THE recalculation (Issue #16 AC8): the
 * streak and last-active date are a pure function of (starting fold, set of award days, today). The same
 * inputs always give the same result, whatever order or repetition the days arrive in, and it equals
 * applying `nextStreak` one day at a time.
 *
 * A day older than the running last-active date is "already covered" and skipped, but only while that date
 * is not in the future: if the date lies after `today` (clock skew / a forged date), `nextStreak` moves it
 * back to the award day, so the day must be applied, not skipped. (This is why a recorded award for today is
 * never dropped when the stored date is in the future.)
 */
export const replayAwardDays = (
  streakDays: number,
  lastActiveDate: string | null,
  days: Iterable<string>,
  today: string,
): { streakDays: number; lastActiveDate: string | null } => {
  let state = { streakDays, lastActiveDate };
  for (const day of [...new Set(days)].sort()) {
    if (state.lastActiveDate !== null && day < state.lastActiveDate && state.lastActiveDate <= today) continue;
    state = nextStreak(state.streakDays, state.lastActiveDate, day);
  }
  return state;
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

/**
 * The retained award-day history (`treeState.activeDays`, Issue #16 AC8): real calendar dates only,
 * de-duplicated, oldest first. `null` means the tree has not adopted the history yet (a legacy document with
 * no such field, or a stored value that is not an array): reads then fall back to the stored fold.
 */
export const normalizeActiveDays = (raw: unknown): string[] | null => {
  if (!Array.isArray(raw)) return null;
  const days = new Set<string>();
  for (const entry of raw) {
    if (isValidCalendarDate(entry)) days.add(entry);
  }
  return [...days].sort();
};

/**
 * Strict integrity check of the STORED retained history (Issue #16 AC8), used before anything is written to it.
 * `absent` (missing or null) is a legacy tree that has not adopted yet. `valid` means an array of real calendar
 * dates, each at most once, no longer than ACTIVE_DAYS_MAX: exactly what the award itself ($addToSet, capped)
 * produces. Anything else is `malformed`, and integrity cannot be established: the award path REFUSES (it never
 * normalises, deduplicates or truncates a stored history). Reads are different and cannot refuse: they fold the
 * valid, distinct entries in memory (`normalizeActiveDays`) and write nothing.
 */
export type ActiveDaysCheck =
  | { status: 'absent' }
  | { status: 'valid'; days: string[] }
  | { status: 'malformed'; reason: 'not_an_array' | 'over_cap' | 'invalid_date' | 'duplicate_day' };

export const validateActiveDays = (raw: unknown): ActiveDaysCheck => {
  if (raw === undefined || raw === null) return { status: 'absent' };
  if (!Array.isArray(raw)) return { status: 'malformed', reason: 'not_an_array' };
  if (raw.length > ACTIVE_DAYS_MAX) return { status: 'malformed', reason: 'over_cap' };
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isValidCalendarDate(entry)) return { status: 'malformed', reason: 'invalid_date' };
    if (seen.has(entry)) return { status: 'malformed', reason: 'duplicate_day' };
    seen.add(entry);
  }
  return { status: 'valid', days: [...seen].sort() };
};

/**
 * The award days a stored fold SUPPORTS: a streak of N ending on day D means N consecutive award days ending on
 * D, so those days are known exactly even though they were never stored. Only what is defensible is inferred:
 *   - no streak (0), no valid last-active date, or a last-active date more than ONE UTC day ahead of today
 *     (more than any clock skew explains): nothing is inferred (`[]`), so no streak is invented;
 *   - a last-active date one day ahead (clock skew between instances) counts as today, as `nextStreak` does;
 *   - a streak that cannot be represented (longer than the history can hold, or running before the calendar
 *     starts) returns `null`: adoption must be refused, never shortened.
 * Earlier activity is not recoverable, by design. The streak is checked BEFORE any day is generated, so a forged
 * huge value costs nothing.
 */
export const impliedStreakDays = (streakDays: number, lastActiveDate: string | null, today: string): string[] | null => {
  if (lastActiveDate === null || streakDays <= 0) return [];
  if (lastActiveDate > addDays(today, 1)) return [];
  if (streakDays > ACTIVE_DAYS_MAX) return null;
  const end = lastActiveDate > today ? today : lastActiveDate;
  const days: string[] = [];
  for (let back = streakDays - 1; back >= 0; back -= 1) {
    const day = addDays(end, -back);
    if (!isValidCalendarDate(day)) return null;
    days.push(day);
  }
  return days;
};

/**
 * What a legacy document's history would start as when it adopts `activeDays`: the days its stored streak
 * supports (`impliedStreakDays`) plus every valid day left in the old recovery marker (`pendingDerivedDays`),
 * de-duplicated, oldest first. The COMPLETE set is validated before anything is written: `null` means it cannot
 * be adopted (the streak is unrepresentable, or the set, plus `extraDay` when the caller is about to award
 * that day, would exceed ACTIVE_DAYS_MAX), and the caller must refuse without touching the record. `extraDay`
 * only reserves its slot; it is not part of the returned days.
 */
export const planLegacyAdoption = (raw: unknown, now: Date, extraDay?: string): string[] | null => {
  const stored = asRecord(raw);
  const implied = impliedStreakDays(normalizeStreakDays(stored.streakDays), normalizeLastActiveDate(stored.lastActiveDate), getTodayUtc(now));
  if (implied === null) return null;
  const days = new Set([...implied, ...normalizePendingDays(stored.pendingDerivedDays)]);
  const reserved = new Set(days);
  if (extraDay !== undefined) reserved.add(extraDay);
  if (reserved.size > ACTIVE_DAYS_MAX) return null;
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

/**
 * The streak and last-active date a tree MEANS right now, before idleness is applied (Issue #16 AC8).
 *
 *   adopted    (`activeDays` is an array)  the fold of the retained history alone, from nothing: the history is
 *                                          canonical, the stored streak/date are only a materialised copy.
 *   legacy     (no `activeDays` yet)       the stored fold plus any day still in the old recovery marker.
 *
 * Pure and write-free, so a read can show a recorded-but-unreconciled award without persisting anything.
 */
export const effectiveFold = (raw: unknown, now: Date): { streakDays: number; lastActiveDate: string | null; adopted: boolean } => {
  const stored = asRecord(raw);
  const today = getTodayUtc(now);
  const days = normalizeActiveDays(stored.activeDays);
  if (days !== null) return { ...replayAwardDays(0, null, days, today), adopted: true };
  const state = normalizeTreeState(raw, now);
  const pending = normalizePendingDays(stored.pendingDerivedDays);
  return { ...replayAwardDays(state.streakDays, state.lastActiveDate, pending, today), adopted: false };
};

/**
 * True when the stored derived fields (streak, last-active date) are not what the history says they should
 * be: an award is recorded whose materialised copy never landed (or the copy was damaged). An adopted tree
 * compares the copy to the fold of its history; a legacy tree is out of date only while a day waits in the
 * old marker. Pure: it only reports, the award path repairs.
 */
export const needsReconcile = (raw: unknown, now: Date): boolean => {
  const stored = asRecord(raw);
  const fold = effectiveFold(raw, now);
  if (!fold.adopted) return normalizePendingDays(stored.pendingDerivedDays).length > 0;
  return normalizeStreakDays(stored.streakDays) !== fold.streakDays || normalizeLastActiveDate(stored.lastActiveDate) !== fold.lastActiveDate;
};

/**
 * What a read returns: the stored state with the EFFECTIVE streak, health and status for `now` (Issue #16).
 * Pure: it never writes. The streak and last-active date come from `effectiveFold`, so a completion that was
 * recorded but not yet reconciled is never shown as an idle tree; storage keeps whatever it has until the next
 * award or retry repairs it. xp, leaves, stage and the ledger are exactly the stored values, so no amount of
 * idleness can lower them.
 */
export const presentTreeState = (raw: unknown, now: Date): PresentedTree => {
  const state = normalizeTreeState(raw, now);
  const today = getTodayUtc(now);
  const folded = effectiveFold(raw, now);
  const info = deriveTreeStatus(folded.streakDays, folded.lastActiveDate, state.xp, today);
  return {
    ...state,
    streakDays: info.effectiveStreakDays,
    lastActiveDate: folded.lastActiveDate,
    health: info.health,
    status: info.status,
    daysSinceActive: info.daysSinceActive,
  };
};

export const summarizeTree = ({ awardedTaskIds: _ledger, ...summary }: PresentedTree): TreeSummary => summary;
