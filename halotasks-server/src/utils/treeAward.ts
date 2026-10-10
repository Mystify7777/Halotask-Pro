import User from '../models/User.model';
import {
  AWARDED_TASK_IDS_MAX,
  MAX_XP,
  XP_PER_COMPLETION,
  getHealthForStreak,
  getTodayUtc,
  isValidAwardedTaskId,
  nextStreak,
  normalizeTreeState,
  normalizePendingDays,
  normalizeXp,
  summarizeTree,
  type GrowthResult,
  type TreeState,
} from './treeRules';

// ── The server-side reward (Issue #24) ──────────────────────────────────────────
//
// Called by the task controller when a task goes incomplete -> complete (PUT) or is created already
// completed (POST). It is the ONLY code that raises xp or appends to awardedTaskIds.
//
// Why two steps, and why it is safe
// ---------------------------------
// STEP 1 — the award. One conditional update on the user's document:
//
//     filter  { _id, treeState.awardedTaskIds: {$ne: taskId},            <- not awarded yet
//                    treeState.awardedTaskIds.<MAX-1>: {$exists: false},   <- ledger not full
//                    treeState.xp: {$gte: 0, $lte: MAX_XP - 10} }          <- xp is a usable number
//     update  { $inc: {treeState.xp: 10}, $push: {treeState.awardedTaskIds: taskId} }
//
//   MongoDB applies a single-document update atomically, so the duplicate check and the XP +
//   ledger write cannot be separated: of any number of concurrent calls for the same task exactly one
//   matches the filter; the rest match nothing. Different tasks each $inc atomically, so no XP is
//   lost. Only $inc/$push/$ne/$exists/$gte/$lte are used (no update pipeline, no version
//   requirement). The task document is NOT part of this update, so the award is idempotent BY TASK
//   ID and never depends on what the client believes the tree looks like.
//
// STEP 2 — streak, date and the derived cache. A compare-and-set $set pinned to the values it read
//   (xp, streakDays, lastActiveDate, the recovery marker is deliberately not pinned, see RECOVERY). If another request changed any of them first,
//   re-read and recompute. Losing the race is harmless: the date-based rule gives the same answer for
//   everyone on the same day.
//
// RECOVERY. Step 1 also adds the award's UTC day to `treeState.pendingDerivedDays` ($addToSet) in the SAME
//   atomic update; step 2 removes the whole marker in the same compare-and-set that writes the derived
//   fields. So "award recorded, derived state not yet" is visible in the data, not just in a request that
//   may have died. The marker is a SET OF DAYS, not one timestamp: if derived writes fail on several days
//   in a row, every one of those days is still known, so reconciliation replays each streak transition in
//   order (Mon, Tue, ... then today for a new award) instead of collapsing them.
//   - If step 2 fails (database error) or loses five compare-and-sets in a row, the call THROWS
//     TreeAwardError('derived_unpersisted'). It never returns an unpersisted projection as if it were the
//     tree. The XP and ledger entry are durable; the marker stays.
//   - A retry of the same completion finds the id in the ledger (no second award), sees the marker, and
//     re-runs step 2 for the recorded days — then answers `already_awarded` with the PERSISTED state.
//     Without a marker, an already-awarded retry changes nothing (re-completing an old task is not new
//     activity, so it cannot keep a streak alive).
//   - Any later award also clears a leftover marker: step 2 first applies the recorded days, then today.
//   The compare-and-set is pinned to xp, streakDays and lastActiveDate but not to the marker: days are only
//   ever added together with an xp $inc, so a pin on xp already fails if a day was added after we read.
//
// Stored leaves/stage/health are only a cache; every read path derives them again (treeRules).

/**
 * invalid_task_id / user_not_found — nothing was changed.
 * conflict            — the award itself could not be recorded (step 1); nothing was changed.
 * derived_unpersisted — the award IS recorded (XP + ledger) but its streak/derived write is not; a retry
 *                       of the same completion reconciles it without awarding again.
 */
export type TreeAwardErrorKind = 'invalid_task_id' | 'user_not_found' | 'conflict' | 'derived_unpersisted';

/** An infrastructure/consistency failure. Carries no database text, ids or credentials. */
export class TreeAwardError extends Error {
  constructor(public readonly kind: TreeAwardErrorKind) {
    super(`Growth Tree award failure: ${kind}`);
    this.name = 'TreeAwardError';
  }
}

const MAX_AWARD_ATTEMPTS = 3;
const MAX_DERIVED_ATTEMPTS = 5;

type Stored = Record<string, unknown>;

const treeOf = (doc: unknown): Stored => {
  const tree = (doc as { treeState?: unknown } | null)?.treeState;
  return typeof tree === 'object' && tree !== null ? (tree as Stored) : {};
};

/**
 * The value to compare against in a compare-and-set filter. `null` matches both an explicit null and a
 * missing field, which is what we want for legacy documents. (Typed loosely on purpose: the value comes
 * straight from storage, which is exactly what is being re-validated here.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pin = (value: unknown): any => (value === undefined ? null : value);

const attemptAward = (userId: string, taskId: string, now: Date) =>
  User.findOneAndUpdate(
    {
      _id: userId,
      'treeState.awardedTaskIds': { $ne: taskId },
      [`treeState.awardedTaskIds.${AWARDED_TASK_IDS_MAX - 1}`]: { $exists: false },
      'treeState.xp': { $gte: 0, $lte: MAX_XP - XP_PER_COMPLETION },
    },
    {
      $inc: { 'treeState.xp': XP_PER_COMPLETION },
      $push: { 'treeState.awardedTaskIds': taskId },
      // Every unreconciled award day is kept (a set: one entry per distinct UTC day).
      $addToSet: { 'treeState.pendingDerivedDays': getTodayUtc(now) },
    },
    { returnDocument: 'after', select: 'treeState' },
  ).lean();

const refused = (
  taskId: string,
  reason: NonNullable<GrowthResult['reason']>,
  stored: Stored,
  now: Date,
): GrowthResult => ({
  taskId,
  awarded: false,
  xpGained: 0,
  reason,
  treeState: summarizeTree(normalizeTreeState(stored, now)),
});

const hasMarker = (stored: Stored): boolean => Array.isArray(stored.pendingDerivedDays) && stored.pendingDerivedDays.length > 0;

/**
 * The state the derived write should persist: the streak transition for EVERY recorded award days, oldest
 * first, then (for a new award) today; then health/leaves/stage from the result. A day that is earlier than
 * the stored last-active date is skipped (a later award already covered it), and repeated days collapse.
 */
const project = (observed: Stored, now: Date, includeToday: boolean): TreeState => {
  const state = normalizeTreeState(observed, now);
  const today = getTodayUtc(now);
  const days = new Set(normalizePendingDays(observed.pendingDerivedDays));
  if (includeToday) days.add(today);

  let { streakDays, lastActiveDate } = state;
  for (const day of [...days].sort()) {
    // A recorded day older than the stored last-active date was already covered. Today's own award is never
    // skipped: nextStreak moves a last-active date that lies in the future back to today (existing rule).
    if (lastActiveDate !== null && day < lastActiveDate && !(includeToday && day === today)) continue;
    ({ streakDays, lastActiveDate } = nextStreak(streakDays, lastActiveDate, day));
  }

  return {
    ...state,
    streakDays,
    lastActiveDate,
    health: getHealthForStreak(streakDays, lastActiveDate, today),
    lastCalculatedAt: now.toISOString(),
  };
};

/**
 * Step 2: persist the derived fields with a compare-and-set pinned to what was observed, and clear the
 * recovery marker in the same write. Returns the PERSISTED tree. Throws derived_unpersisted — never a
 * projection — when it cannot be written (database error, or five lost races in a row).
 */
const persistDerived = async (
  userId: string,
  start: Stored,
  now: Date,
  includeToday: boolean,
): Promise<TreeState> => {
  let observed = start;

  try {
    for (let attempt = 0; attempt < MAX_DERIVED_ATTEMPTS; attempt += 1) {
      const next = project(observed, now, includeToday);
      const set: Record<string, unknown> = {
        'treeState.streakDays': next.streakDays,
        'treeState.lastActiveDate': next.lastActiveDate,
        'treeState.health': next.health,
        'treeState.leaves': next.leaves,
        'treeState.stage': next.stage,
        'treeState.lastCalculatedAt': next.lastCalculatedAt,
      };
      // A fractional xp left by old data is floored in the same pinned write; valid xp is untouched.
      if (observed.xp !== next.xp) set['treeState.xp'] = next.xp;

      const written = await User.findOneAndUpdate(
        {
          _id: userId,
          'treeState.xp': pin(observed.xp),
          'treeState.streakDays': pin(observed.streakDays),
          'treeState.lastActiveDate': pin(observed.lastActiveDate),
        },
        { $set: set, $unset: { 'treeState.pendingDerivedDays': '' } },
        { returnDocument: 'after', select: 'treeState' },
      ).lean();

      if (written) return normalizeTreeState(treeOf(written), now);

      const fresh = await User.findById(userId).select('treeState').lean();
      if (!fresh) throw new TreeAwardError('user_not_found');
      observed = treeOf(fresh);
      // Someone else reconciled it first: nothing left to do for this call except report what is stored.
      if (!hasMarker(observed) && !includeToday) return normalizeTreeState(observed, now);
    }
  } catch (error) {
    if (error instanceof TreeAwardError) throw error;
    console.error('[Tree] Derived Growth Tree state could not be written; the award is recorded and will be reconciled.');
    throw new TreeAwardError('derived_unpersisted');
  }

  console.error('[Tree] Derived Growth Tree state lost repeated conflicts; the award is recorded and will be reconciled.');
  throw new TreeAwardError('derived_unpersisted');
};

/**
 * What a POST needs when the award is recorded but its derived write is not: the persisted tree as it
 * stands (read back, never projected), or undefined if even that cannot be read.
 */
export async function readPersistedGrowth(userId: string, taskId: string, now: Date = new Date()): Promise<GrowthResult | undefined> {
  try {
    const current = await User.findById(userId).select('treeState').lean();
    if (!current) return undefined;
    const tree = normalizeTreeState(treeOf(current), now);
    if (!tree.awardedTaskIds.includes(taskId)) return undefined;
    return { taskId, awarded: true, xpGained: XP_PER_COMPLETION, treeState: summarizeTree(tree) };
  } catch {
    return undefined;
  }
}

export async function awardTaskCompletion(
  userId: string,
  taskId: string,
  now: Date = new Date(),
): Promise<GrowthResult> {
  if (!isValidAwardedTaskId(taskId)) throw new TreeAwardError('invalid_task_id');

  // ── Step 1: the atomic, idempotent award ──────────────────────────────────────
  let awarded: unknown = null;
  for (let attempt = 0; attempt < MAX_AWARD_ATTEMPTS && !awarded; attempt += 1) {
    awarded = await attemptAward(userId, taskId, now);
    if (awarded) break;

    // Matched nothing: find out why. (A concurrent duplicate may have won between our attempts.)
    const current = await User.findById(userId).select('treeState').lean();
    if (!current) throw new TreeAwardError('user_not_found');

    const stored = treeOf(current);
    const ledger = Array.isArray(stored.awardedTaskIds) ? stored.awardedTaskIds : [];

    if (ledger.includes(taskId)) {
      // No second award. If that earlier award's derived write never landed, finish it now; otherwise
      // (the normal retry / re-complete) nothing is written.
      if (!hasMarker(stored)) return refused(taskId, 'already_awarded', stored, now);
      const reconciled = await persistDerived(userId, stored, now, false);
      return { taskId, awarded: false, xpGained: 0, reason: 'already_awarded', treeState: summarizeTree(reconciled) };
    }
    if (ledger.length >= AWARDED_TASK_IDS_MAX) return refused(taskId, 'ledger_full', stored, now);
    if (normalizeXp(stored.xp) > MAX_XP - XP_PER_COMPLETION) return refused(taskId, 'xp_ceiling', stored, now);

    // Not a duplicate, not full: the stored xp is not a usable number (missing, Infinity, negative,
    // ...). Repair it — pinned to the exact value we saw, so a concurrent change is never overwritten —
    // and try the award again. Valid XP is never reduced here.
    await User.updateOne(
      { _id: userId, 'treeState.xp': pin(stored.xp) },
      { $set: { 'treeState.xp': normalizeXp(stored.xp) } },
    );
  }
  if (!awarded) throw new TreeAwardError('conflict');

  // ── Step 2: streak / date / derived cache (throws derived_unpersisted rather than guess) ──
  const final = await persistDerived(userId, treeOf(awarded), now, true);

  return { taskId, awarded: true, xpGained: XP_PER_COMPLETION, treeState: summarizeTree(final) };
}
