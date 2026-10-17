import User from '../models/User.model';
import {
  ACTIVE_DAYS_MAX,
  AWARDED_TASK_IDS_MAX,
  MAX_XP,
  XP_PER_COMPLETION,
  deriveTreeStatus,
  effectiveFold,
  getTodayUtc,
  isValidAwardedTaskId,
  needsReconcile,
  normalizeTreeState,
  presentTreeState,
  normalizeXp,
  planLegacyAdoption,
  summarizeTree,
  validateActiveDays,
  type GrowthResult,
  type PresentedTree,
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
//                    treeState.xp: {$gte: 0, $lte: MAX_XP - 10},           <- xp is a usable number
//                    treeState.activeDays: {$type: 'array'},               <- history adopted ...
//                    $or: [ {treeState.activeDays: <today>},               <- ... and today already in it,
//                           {treeState.activeDays.<MAX-1>: {$exists: false}} ] } <- or room for it
//     update  { $inc: {treeState.xp: 10}, $push: {treeState.awardedTaskIds: taskId},
//               $addToSet: {treeState.activeDays: <today>} }
//
//   MongoDB applies a single-document update atomically, so the duplicate check and the XP +
//   ledger write cannot be separated: of any number of concurrent calls for the same task exactly one
//   matches the filter; the rest match nothing. Different tasks each $inc atomically, so no XP is
//   lost. Only $inc/$push/$addToSet/$ne/$exists/$gte/$lte/$type/$or are used (no update pipeline, no
//   version requirement). The task document is NOT part of this update, so the award is idempotent BY TASK
//   ID and never depends on what the client believes the tree looks like.
//
// STEP 2 — streak, date and the derived cache. A compare-and-set $set pinned to the values it read
//   (xp, streakDays, lastActiveDate). If another request changed any of them first, re-read and recompute.
//   Losing the race is harmless: the streak is a pure function of the retained history (below), so everyone
//   computes the same answer.
//
// RETAINED HISTORY (Issue #16 AC8). Step 1 also adds the award's UTC day to `treeState.activeDays` ($addToSet,
//   one entry per distinct day) in the SAME atomic update as the XP and the ledger entry. That history is the
//   CANONICAL source of the streak and last-active date: `replayAwardDays` over it, from nothing, is the one
//   recalculation (same days -> same result, whatever order, repetition, retry or concurrency produced them).
//   The stored streakDays/lastActiveDate/health/leaves/stage are a MATERIALISED COPY that step 2 writes and
//   that may be validated (`needsReconcile`) and repaired at any time. XP and the task ledger keep their own,
//   separate authority (the atomic award above): the history never changes either.
//   - "Award recorded, copy not yet written" is visible in the data itself (copy != fold of the history), not
//     just in a request that may have died. If step 2 fails (database error) or loses five compare-and-sets in
//     a row, the call THROWS TreeAwardError('derived_unpersisted'); it never returns an unpersisted projection
//     as if it were the tree. A retry of the same completion finds the id in the ledger (no second award),
//     sees the stale copy, and rewrites it from the history. Without a stale copy an already-awarded retry
//     changes nothing (re-completing an old task is not new activity, so it cannot keep a streak alive).
//   - Any later award repairs a stale copy too: its step 2 folds the whole history, including the earlier day.
//   - Reads are write-free: they fold the history in memory (`presentTreeState`).
//   - Bound: at most ACTIVE_DAYS_MAX days. The history is never truncated: a day that would not fit is
//     refused (reason 'history_full'), exactly like a full ledger.
//   - Adoption: a legacy tree has no `activeDays`. Before its first award it adopts one in a single pinned
//     write: the days its stored streak SUPPORTS (N consecutive days ending on the last-active date; nothing is
//     inferred from a zero streak, a missing/invalid date, or a date more than a day ahead) plus any day left in
//     the old `pendingDerivedDays` marker, which is removed in the same write. The COMPLETE set, with the slot
//     for the day being awarded, is validated against ACTIVE_DAYS_MAX BEFORE anything is written; if it cannot
//     fit, the call is refused ('history_full') and the legacy record is left exactly as it was (never shortened
//     or clamped). Activity before that is not recoverable and is not claimed to be (docs/context.md).
//   - Integrity: before any award, the stored history is validated strictly (`validateActiveDays`: an array of
//     real dates, each once, at most ACTIVE_DAYS_MAX). Anything else (not an array, invalid date, duplicate,
//     over the cap) means integrity cannot be established: the call throws TreeAwardError('conflict') and
//     writes NOTHING. The award path never normalises, deduplicates or truncates a stored history.
//
// Stored leaves/stage/health are only a cache; every read path derives them again (treeRules).

/**
 * invalid_task_id / user_not_found — nothing was changed.
 * conflict            — the award could not be recorded (step 1) or the stored award-day history failed
 *                       validation (integrity cannot be established); nothing was changed.
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

const MAX_AWARD_ATTEMPTS = 4;
const MAX_DERIVED_ATTEMPTS = 5;

type Stored = Record<string, unknown>;

const treeOf = (doc: unknown): Stored => {
  const tree = (doc as { treeState?: unknown } | null)?.treeState;
  return typeof tree === 'object' && tree !== null ? (tree as Stored) : {};
};

/**
 * Strict integrity gate for the stored history: throws TreeAwardError('conflict') (writing nothing) unless it is
 * absent (legacy) or valid. Logs only the failed rule, never data.
 */
const assertHistoryIntact = (rawActiveDays: unknown): void => {
  const check = validateActiveDays(rawActiveDays);
  if (check.status !== 'malformed') return;
  console.error(`[Tree] Stored award-day history failed validation (${check.reason}); no award was made and nothing was changed.`);
  throw new TreeAwardError('conflict');
};

/**
 * The value to compare against in a compare-and-set filter. `null` matches both an explicit null and a
 * missing field, which is what we want for legacy documents. (Typed loosely on purpose: the value comes
 * straight from storage, which is exactly what is being re-validated here.)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pin = (value: unknown): any => (value === undefined ? null : value);

const attemptAward = (userId: string, taskId: string, now: Date) => {
  const today = getTodayUtc(now);
  return User.findOneAndUpdate(
    {
      _id: userId,
      'treeState.awardedTaskIds': { $ne: taskId },
      [`treeState.awardedTaskIds.${AWARDED_TASK_IDS_MAX - 1}`]: { $exists: false },
      'treeState.xp': { $gte: 0, $lte: MAX_XP - XP_PER_COMPLETION },
      // The history must have been adopted (an array), and have room for today unless today is already in it.
      'treeState.activeDays': { $type: 'array' },
      $or: [{ 'treeState.activeDays': today }, { [`treeState.activeDays.${ACTIVE_DAYS_MAX - 1}`]: { $exists: false } }],
    },
    {
      $inc: { 'treeState.xp': XP_PER_COMPLETION },
      $push: { 'treeState.awardedTaskIds': taskId },
      // The award day joins the retained history in the same atomic write (a set: one entry per UTC day).
      $addToSet: { 'treeState.activeDays': today },
    },
    { returnDocument: 'after', select: 'treeState' },
  ).lean();
};

/**
 * Adoption of the retained history by a legacy tree (see the header). One write, pinned to the xp, streak and
 * date it read: a legacy award always moves xp together with its marker day, so a pin on xp also fails if a
 * day was added after the read. Losing the race is harmless; the caller re-reads. `days` is the plan the caller
 * already validated (`planLegacyAdoption`). A stored `activeDays` that is neither missing nor null does not match
 * the pin and is left alone (the strict validation in the award path refuses such a record first).
 */
const adopt = async (userId: string, stored: Stored, days: string[]): Promise<void> => {
  await User.updateOne(
    {
      _id: userId,
      'treeState.activeDays': null,
      'treeState.xp': pin(stored.xp),
      'treeState.streakDays': pin(stored.streakDays),
      'treeState.lastActiveDate': pin(stored.lastActiveDate),
    },
    { $set: { 'treeState.activeDays': days }, $unset: { 'treeState.pendingDerivedDays': '' } },
  );
};

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
  treeState: summarizeTree(presentTreeState(stored, now)),
});

/**
 * The state the derived write should persist: the streak and last-active date are the fold of the retained
 * history (`effectiveFold`), health/leaves/stage follow from that result and the xp.
 */
const project = (observed: Stored, now: Date): TreeState => {
  const state = normalizeTreeState(observed, now);
  const { streakDays, lastActiveDate } = effectiveFold(observed, now);

  return {
    ...state,
    streakDays,
    lastActiveDate,
    health: deriveTreeStatus(streakDays, lastActiveDate, state.xp, getTodayUtc(now)).health,
    lastCalculatedAt: now.toISOString(),
  };
};

/**
 * Step 2: persist the derived fields with a compare-and-set pinned to what was observed. Returns the
 * PERSISTED tree. Throws derived_unpersisted — never a projection — when it cannot be written (database
 * error, or five lost races in a row).
 */
const persistDerived = async (userId: string, start: Stored, now: Date): Promise<PresentedTree> => {
  let observed = start;

  try {
    for (let attempt = 0; attempt < MAX_DERIVED_ATTEMPTS; attempt += 1) {
      const next = project(observed, now);
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
        { $set: set },
        { returnDocument: 'after', select: 'treeState' },
      ).lean();

      if (written) return presentTreeState(treeOf(written), now);

      const fresh = await User.findById(userId).select('treeState').lean();
      if (!fresh) throw new TreeAwardError('user_not_found');
      observed = treeOf(fresh);
      // Someone else repaired it first: nothing left to do for this call except report what is stored.
      if (!needsReconcile(observed, now)) return presentTreeState(observed, now);
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
    const tree = presentTreeState(treeOf(current), now);
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

  // ── Pre-flight: integrity of the stored history (one lean read, nothing written) ──
  const preflight = await User.findById(userId).select('treeState.activeDays').lean();
  if (!preflight) throw new TreeAwardError('user_not_found');
  assertHistoryIntact(treeOf(preflight).activeDays);

  // ── Step 1: the atomic, idempotent award ──────────────────────────────────────
  let awarded: unknown = null;
  for (let attempt = 0; attempt < MAX_AWARD_ATTEMPTS && !awarded; attempt += 1) {
    awarded = await attemptAward(userId, taskId, now);
    if (awarded) break;

    // Matched nothing: find out why. (A concurrent duplicate may have won between our attempts.)
    const current = await User.findById(userId).select('treeState').lean();
    if (!current) throw new TreeAwardError('user_not_found');

    const stored = treeOf(current);
    assertHistoryIntact(stored.activeDays); // defensive: a concurrent change cannot make a refused record writable
    const ledger = Array.isArray(stored.awardedTaskIds) ? stored.awardedTaskIds : [];
    const legacy = !Array.isArray(stored.activeDays);

    if (ledger.includes(taskId)) {
      // No second award. If that earlier award's derived copy is stale, finish it now; otherwise (the
      // normal retry / re-complete) nothing is written.
      if (!needsReconcile(stored, now)) return refused(taskId, 'already_awarded', stored, now);
      if (legacy) {
        // A legacy marker day: adopt first, then repair on the next pass. If the set cannot fit, change nothing.
        const plan = planLegacyAdoption(stored, now);
        if (plan === null) return refused(taskId, 'already_awarded', stored, now);
        await adopt(userId, stored, plan);
        continue;
      }
      const reconciled = await persistDerived(userId, stored, now);
      return { taskId, awarded: false, xpGained: 0, reason: 'already_awarded', treeState: summarizeTree(reconciled) };
    }
    if (ledger.length >= AWARDED_TASK_IDS_MAX) return refused(taskId, 'ledger_full', stored, now);
    if (normalizeXp(stored.xp) > MAX_XP - XP_PER_COMPLETION) return refused(taskId, 'xp_ceiling', stored, now);
    if (!legacy && (stored.activeDays as unknown[]).length >= ACTIVE_DAYS_MAX && !(stored.activeDays as unknown[]).includes(getTodayUtc(now))) {
      return refused(taskId, 'history_full', stored, now);
    }

    // A legacy tree: validate the complete adopted set (with room for today), then adopt it in one pinned
    // write and try the award again. A set that cannot fit is refused and the record is left untouched.
    if (legacy) {
      const plan = planLegacyAdoption(stored, now, getTodayUtc(now));
      if (plan === null) return refused(taskId, 'history_full', stored, now);
      await adopt(userId, stored, plan);
      continue;
    }

    // Not a duplicate, not full, history in place: the stored xp is not a usable number (missing, Infinity,
    // negative, ...). Repair it — pinned to the exact value we saw, so a concurrent change is never
    // overwritten — and try the award again. Valid XP is never reduced here.
    await User.updateOne(
      { _id: userId, 'treeState.xp': pin(stored.xp) },
      { $set: { 'treeState.xp': normalizeXp(stored.xp) } },
    );
  }
  if (!awarded) throw new TreeAwardError('conflict');

  // ── Step 2: streak / date / derived cache (throws derived_unpersisted rather than guess) ──
  const final = await persistDerived(userId, treeOf(awarded), now);

  return { taskId, awarded: true, xpGained: XP_PER_COMPLETION, treeState: summarizeTree(final) };
}
