import mongoose from 'mongoose';
import CompletionRecord from '../models/CompletionRecord.model';
import {
  COMPLETION_ID_REUSED,
  COMPLETION_TASK_MISMATCH,
  COMPLETION_TIME_OUT_OF_WINDOW,
  isWithinEventWindow,
} from './completionValidators';

// ── The server side of completion events (Issue #47) ────────────────────────────────────────────────────────────
//
// This is the ONLY code that writes CompletionRecord. Both entry points (a `completionEvent` on a task write and
// POST /api/completion-events) call these functions, so one completionId can resolve to one record and the rules below
// are written once.
//
// TWO KINDS OF CONSISTENCY — they are different problems with different mechanisms.
//
// 1. FAILURE / RETRY consistency (one request dies half-way). MongoDB transactions need a replica set, which neither the
//    development setup nor the test setup (a single in-memory mongod) provides, and nothing else in this server uses them.
//    So the boundary is an ORDER plus IDEMPOTENCE, the same reasoning as the Growth Tree award (utils/treeAward.ts):
//    a failed step fails the request (HTTP 5xx), the client retries the SAME request, and every earlier step is a no-op.
//
// 2. CONCURRENT-TRANSITION consistency (two requests act on one task at the same time: complete vs uncomplete, or two
//    devices completing). Retrying cannot repair this, because the two requests are different requests. It is resolved by
//    making the TASK WRITE the arbiter (utils/taskCompletion.ts): a transition is committed by ONE conditional write on
//    the Task document that also records which completion the task now owns (`Task.completionId`). MongoDB serialises
//    writes to one document, so exactly one of two opposing requests commits, and the records then follow the committed task
//    state. Everything in THIS file supports that:
//      - a request only ever revokes the EXACT completion id its own commit replaced or ended, never "whatever is active", so
//        a stale request can never revoke a newer completion;
//      - a record only moves forward (absent -> active -> revoked) and is never re-activated, so a late, duplicate or
//        replayed write can only be a no-op or a correct catch-up;
//      - a record that turns out not to be the task's current completion any more (it was inserted after a newer transition
//        committed) is revoked by its own request, which re-checks ownership after inserting.
//
// ATOMIC WINNER FOR RECORDS. "At most one active live completion per task" is also enforced by the partial unique index,
// not by reading first: the database is the backstop for every path, including POST /api/completion-events for a task that
// no longer exists. Duplicate-key errors are told apart by READING the record back (is there already a record with this
// completionId?), not by parsing driver error text.

export type RecordOutcome = 'recorded' | 'duplicate' | 'superseded' | 'rejected';
export type RevokeOutcome = 'revoked' | 'already_revoked' | 'not_found' | 'rejected';

export type RecordResult = {
  outcome: RecordOutcome;
  completionId?: string;
  code?: string;
  /** For 'duplicate': the status the stored record has now. */
  status?: 'active' | 'revoked';
};

export type RevokeResult = { outcome: RevokeOutcome; completionId?: string; code?: string };

export type CompletionInput = {
  completionId: string;
  taskId: string;
  titleSnapshot: string;
  estimatedMinutesSnapshot: number;
  completedAt: Date;
  utcOffsetMinutes: number;
  localDate: string;
};

type StoredRecord = {
  completionId: string;
  taskId: string;
  completedAt: Date | null;
  utcOffsetMinutes: number | null;
  status: 'active' | 'revoked';
};

/** How often one request tries to take a task's single active slot before giving up (a 5xx; the client retries). */
const MAX_SLOT_ATTEMPTS = 3;

export const isDuplicateKeyError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

const sameEvent = (stored: StoredRecord, input: CompletionInput): boolean =>
  stored.taskId === input.taskId &&
  stored.utcOffsetMinutes === input.utcOffsetMinutes &&
  stored.completedAt !== null &&
  stored.completedAt.getTime() === input.completedAt.getTime();

/** A repeat of a stored event changes nothing; the same id for a DIFFERENT event is refused, never merged. */
const replayOf = (stored: StoredRecord, input: CompletionInput): RecordResult =>
  sameEvent(stored, input)
    ? { outcome: 'duplicate', completionId: stored.completionId, status: stored.status }
    : { outcome: 'rejected', code: COMPLETION_ID_REUSED };

const findStored = (userId: string, completionId: string) =>
  CompletionRecord.findOne({ userId, completionId }).lean() as unknown as Promise<StoredRecord | null>;

/**
 * Records a completion observed by the client. Idempotent by (userId, completionId).
 * An already-stored event is answered before the window is checked, so a retry that arrives after the window has moved
 * on still gets "duplicate" instead of a rejection of something already recorded.
 */
export async function recordCompletion(userId: string, input: CompletionInput, now: Date = new Date()): Promise<RecordResult> {
  const existing = await findStored(userId, input.completionId);
  if (existing) return replayOf(existing, input);

  if (!isWithinEventWindow(input.completedAt, now)) {
    return { outcome: 'rejected', code: COMPLETION_TIME_OUT_OF_WINDOW };
  }

  const base = {
    userId,
    completionId: input.completionId,
    taskId: input.taskId,
    titleSnapshot: input.titleSnapshot,
    estimatedMinutesSnapshot: input.estimatedMinutesSnapshot,
    completedAt: input.completedAt,
    utcOffsetMinutes: input.utcOffsetMinutes,
    localDate: input.localDate,
    receivedAt: now,
    source: 'live' as const,
    completedAtSource: 'client' as const,
  };

  for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt += 1) {
    try {
      await CompletionRecord.create({ ...base, status: 'active' });
      return { outcome: 'recorded', completionId: input.completionId };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      // Either this very event was inserted meanwhile (a concurrent delivery) ...
      const raced = await findStored(userId, input.completionId);
      if (raced) return replayOf(raced, input);

      // ... or another completion holds the task's active slot.
      const holder = await CompletionRecord.findOne({ userId, taskId: input.taskId, status: 'active', source: 'live' }).lean();
      if (!holder) continue; // it was revoked in the meantime: try to take the slot

      try {
        await CompletionRecord.create({
          ...base,
          status: 'revoked',
          revokedAt: null,
          revokeReceivedAt: now,
          revokedReason: 'superseded',
        });
        return { outcome: 'superseded', completionId: input.completionId };
      } catch (supersedeError) {
        if (!isDuplicateKeyError(supersedeError)) throw supersedeError;
        const settled = await findStored(userId, input.completionId);
        if (settled) return replayOf(settled, input);
        throw supersedeError;
      }
    }
  }

  throw new Error('Could not settle the completion for this task; retry the request.');
}

/**
 * What the server already knows about an incoming completion event, BEFORE the task is touched:
 *  - 'stored':  the event was processed already (same content). It must never complete the task again, whatever its status;
 *  - 'refused': the id belongs to a different event, or the time is outside the window. The task still completes (the user's
 *               action is not lost) but carries no pointer, and the refusal is reported;
 *  - 'new':     a valid event nobody has seen.
 */
export type EventInspection = { kind: 'new' } | { kind: 'stored' } | { kind: 'refused'; code: string };

export async function inspectEvent(userId: string, input: CompletionInput, now: Date = new Date()): Promise<EventInspection> {
  const existing = await findStored(userId, input.completionId);
  if (existing) return sameEvent(existing, input) ? { kind: 'stored' } : { kind: 'refused', code: COMPLETION_ID_REUSED };
  if (!isWithinEventWindow(input.completedAt, now)) return { kind: 'refused', code: COMPLETION_TIME_OUT_OF_WINDOW };
  return { kind: 'new' };
}

/** Looks one record up by its id (an account's own); used to answer "was this event already stored?". */
export const findCompletion = findStored;

/** The id the server mints for a completion a legacy client made (no event, so no client id). Stored on the task as well. */
export const newServerCompletionId = (): string => `srv-${new mongoose.Types.ObjectId().toHexString()}`;

/**
 * A completion that this request committed on the task (the task now owns it). `client`: the event the client made when the
 * user acted. `server`: a legacy client sent no event, so the server saw the transition but not when the user acted or which
 * day it was for them; the record is explicitly lower fidelity (completedAt is the receipt time, the local day is unknown).
 */
export type OwnedCompletion =
  | ({ fidelity: 'client' } & CompletionInput)
  | { fidelity: 'server'; completionId: string; taskId: string; titleSnapshot: string; estimatedMinutesSnapshot: number };

const sameOwned = (stored: StoredRecord, owned: OwnedCompletion): boolean =>
  owned.fidelity === 'client' ? sameEvent(stored, owned) : stored.taskId === owned.taskId;

/**
 * Writes the record for a completion the TASK already owns (its conditional write committed). Idempotent by completionId.
 *
 * It takes the task's single active slot, and treats a holder it finds there as follows. `isOwner` re-reads the task:
 *  - owner (the task still says this completion is current): the holder is older than this commit (the previous
 *    completion, whose revocation was not written yet or whose request died), so it is revoked by its exact id and the
 *    insert is retried;
 *  - not the owner any more (a newer transition committed since): this completion is stored as revoked, never active.
 * After a successful insert the ownership is checked ONCE MORE: an uncomplete that committed and tried to revoke this
 * record before it existed found nothing, so this request revokes it itself. That re-check is what makes the order of
 * "revoke" and "insert" irrelevant.
 */
export async function recordOwnedCompletion(
  userId: string,
  owned: OwnedCompletion,
  isOwner: () => Promise<boolean>,
  now: Date = new Date(),
): Promise<RecordResult> {
  const revokeStale = async (): Promise<void> => {
    await revokeCompletion(userId, { completionId: owned.completionId, taskId: owned.taskId, revokedAt: null }, now);
  };

  const existing = await findStored(userId, owned.completionId);
  if (existing) {
    if (!sameOwned(existing, owned)) return { outcome: 'rejected', code: COMPLETION_ID_REUSED };
    // A late replay of a completion the task no longer owns, still active (its revoke ran before it was inserted): close it.
    if (existing.status === 'active' && !(await isOwner())) {
      await revokeStale();
      return { outcome: 'duplicate', completionId: existing.completionId, status: 'revoked' };
    }
    return { outcome: 'duplicate', completionId: existing.completionId, status: existing.status };
  }

  if (owned.fidelity === 'client' && !isWithinEventWindow(owned.completedAt, now)) {
    return { outcome: 'rejected', code: COMPLETION_TIME_OUT_OF_WINDOW };
  }

  const base =
    owned.fidelity === 'client'
      ? {
          userId,
          completionId: owned.completionId,
          taskId: owned.taskId,
          titleSnapshot: owned.titleSnapshot,
          estimatedMinutesSnapshot: owned.estimatedMinutesSnapshot,
          completedAt: owned.completedAt,
          utcOffsetMinutes: owned.utcOffsetMinutes,
          localDate: owned.localDate,
          receivedAt: now,
          source: 'live' as const,
          completedAtSource: 'client' as const,
        }
      : {
          userId,
          completionId: owned.completionId,
          taskId: owned.taskId,
          titleSnapshot: owned.titleSnapshot,
          estimatedMinutesSnapshot: owned.estimatedMinutesSnapshot,
          completedAt: now,
          utcOffsetMinutes: null,
          localDate: null,
          receivedAt: now,
          source: 'live' as const,
          completedAtSource: 'server' as const,
        };

  for (let attempt = 0; attempt < MAX_SLOT_ATTEMPTS; attempt += 1) {
    try {
      await CompletionRecord.create({ ...base, status: 'active' });
      if (!(await isOwner())) await revokeStale();
      return { outcome: 'recorded', completionId: owned.completionId };
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;

      const raced = await findStored(userId, owned.completionId);
      if (raced) {
        return sameOwned(raced, owned)
          ? { outcome: 'duplicate', completionId: raced.completionId, status: raced.status }
          : { outcome: 'rejected', code: COMPLETION_ID_REUSED };
      }

      const holder = await CompletionRecord.findOne({ userId, taskId: owned.taskId, status: 'active', source: 'live' }).lean();
      if (!holder) continue; // it was revoked in the meantime: try to take the slot

      if (await isOwner()) {
        // Older than this commit: finish its revocation, then take the slot.
        await revokeCompletion(
          userId,
          { completionId: (holder as unknown as StoredRecord).completionId, taskId: owned.taskId, revokedAt: null },
          now,
        );
        continue;
      }

      // A newer transition owns the task: this completion ended before it could count.
      return storeRevoked(userId, base, owned, now, 'superseded');
    }
  }

  throw new Error('Could not settle the completion for this task; retry the request.');
}

/**
 * Stores, for HISTORY ONLY, a completion that lost the transition: another completion already owns the task, so this one
 * (a second device, or a duplicate event) never counts. It does not touch the task's active slot, so it cannot disturb the
 * completion that won. Idempotent by completionId.
 */
export async function recordSupersededCompletion(userId: string, input: CompletionInput, now: Date = new Date()): Promise<RecordResult> {
  const existing = await findStored(userId, input.completionId);
  if (existing) return replayOf(existing, input);

  if (!isWithinEventWindow(input.completedAt, now)) {
    return { outcome: 'rejected', code: COMPLETION_TIME_OUT_OF_WINDOW };
  }

  const base = {
    userId,
    completionId: input.completionId,
    taskId: input.taskId,
    titleSnapshot: input.titleSnapshot,
    estimatedMinutesSnapshot: input.estimatedMinutesSnapshot,
    completedAt: input.completedAt,
    utcOffsetMinutes: input.utcOffsetMinutes,
    localDate: input.localDate,
    receivedAt: now,
    source: 'live' as const,
    completedAtSource: 'client' as const,
  };
  return storeRevoked(userId, base, { fidelity: 'client', ...input }, now, 'superseded');
}

async function storeRevoked(
  userId: string,
  base: Record<string, unknown>,
  owned: OwnedCompletion,
  now: Date,
  reason: 'superseded' | 'uncompleted',
): Promise<RecordResult> {
  try {
    await CompletionRecord.create({ ...base, status: 'revoked', revokedAt: null, revokeReceivedAt: now, revokedReason: reason });
    return { outcome: 'superseded', completionId: owned.completionId };
  } catch (error) {
    if (!isDuplicateKeyError(error)) throw error;
    const settled = await findStored(userId, owned.completionId);
    if (settled) {
      return sameOwned(settled, owned)
        ? { outcome: 'duplicate', completionId: settled.completionId, status: settled.status }
        : { outcome: 'rejected', code: COMPLETION_ID_REUSED };
    }
    throw error;
  }
}

/**
 * Revokes ONE completion by its exact id: the record stays, its status becomes 'revoked'. Idempotent. There is deliberately
 * no "revoke the active one of this task" form: a request that does not know which completion it ends could revoke a newer
 * one. When `taskId` is given, the completion must belong to that task, so an id can never end another task's completion.
 * `revokedAt` is stored only when it is inside the event window; otherwise the revocation still happens (leaving a
 * completion active for a task the user has uncompleted would be worse) and the time is recorded as unknown (null).
 */
export async function revokeCompletion(
  userId: string,
  input: { taskId?: string; completionId: string; revokedAt: Date | null },
  now: Date = new Date(),
): Promise<RevokeResult> {
  const revokedAt = input.revokedAt !== null && isWithinEventWindow(input.revokedAt, now) ? input.revokedAt : null;
  const set = { status: 'revoked', revokedAt, revokeReceivedAt: now, revokedReason: 'uncompleted' };

  const updated = await CompletionRecord.findOneAndUpdate(
    { userId, completionId: input.completionId, status: 'active', ...(input.taskId !== undefined ? { taskId: input.taskId } : {}) },
    { $set: set },
    { returnDocument: 'after' },
  ).lean();
  if (updated) return { outcome: 'revoked', completionId: input.completionId };

  const stored = await findStored(userId, input.completionId);
  if (!stored) return { outcome: 'not_found' };
  if (input.taskId !== undefined && stored.taskId !== input.taskId) {
    return { outcome: 'rejected', code: COMPLETION_TASK_MISMATCH };
  }
  return { outcome: 'already_revoked', completionId: input.completionId };
}

/**
 * COMPENSATION for a record this very request inserted when the request then fails in a way that undoes the task it
 * belonged to (a task created already completed whose award could not be recorded: the new task is removed again, and the
 * client's retry creates a NEW task with a new id). Without this, the retry would find the old record under the same
 * completionId with the old task id and be refused as COMPLETION_ID_REUSED. It is scoped to the exact record and task
 * of this request and only while still active; it is not a history delete.
 */
export async function discardJustRecorded(userId: string, completionId: string, taskId: string): Promise<void> {
  await CompletionRecord.deleteOne({ userId, completionId, taskId, status: 'active' });
}

// -- Migrated records (Issue #47, Phase 2B) ----------------------------------------------------------------------------

export type MigratedCompletionInput = {
  completionId: string;
  taskId: string;
  titleSnapshot: string;
  estimatedMinutesSnapshot: number;
};

export type MigratedDayOutcome = 'created' | 'skipped-existing';

/**
 * Writes ALL the migrated records of one legacy day in ONE MongoDB transaction, or none.
 *
 * Why a transaction and not a loop of inserts: the history read (utils/completionHistory.ts) treats a day as canonical as
 * soon as ANY record has its `localDate`, and the migration skips any day that already has a record. A day left with only
 * some of its records (a crash between two inserts) would therefore read as that partial set FOR GOOD, silently hiding the
 * rest of the legacy snapshot. The transition must be legacy-only -> fully canonical, never partial.
 *
 * Inside the transaction the day is re-checked: if ANY record (any status, any source) holds this `localDate`, nothing is
 * written ('skipped-existing'). A concurrent run that wins the race makes this one hit the unique (userId, completionId)
 * index or a write conflict; MongoDB aborts the loser's whole transaction (withTransaction retries a transient conflict,
 * which then finds the winner's records), so the outcome is the same: the day is written exactly once.
 *
 * It states only what the snapshot proves: the local day. The completion instant and offset are unknown (null) and the
 * records say so (`source`/`completedAtSource` 'migrated'). Migrated records are outside the single-active-live index.
 * Transactions need a replica set or sharded cluster; on a standalone server MongoDB refuses, nothing is written, and the
 * caller reports the day as failed (the CLI also refuses to start an apply there).
 */
export async function recordMigratedDay(
  userId: string,
  localDate: string,
  inputs: MigratedCompletionInput[],
  now: Date = new Date(),
): Promise<MigratedDayOutcome> {
  if (inputs.length === 0) return 'skipped-existing'; // nothing to write is not a migration

  const docs = inputs.map((input) => ({
    userId,
    completionId: input.completionId,
    taskId: input.taskId,
    titleSnapshot: input.titleSnapshot,
    estimatedMinutesSnapshot: input.estimatedMinutesSnapshot,
    completedAt: null,
    utcOffsetMinutes: null,
    localDate,
    receivedAt: now,
    status: 'active' as const,
    source: 'migrated' as const,
    completedAtSource: 'migrated' as const,
  }));

  const session = await CompletionRecord.startSession();
  try {
    let outcome: MigratedDayOutcome = 'created';
    await session.withTransaction(async () => {
      outcome = 'created';
      const present = await CompletionRecord.find({ userId, localDate: { $in: [localDate] } })
        .session(session)
        .select('completionId')
        .lean();
      if (present.length > 0) {
        outcome = 'skipped-existing';
        return;
      }
      await CompletionRecord.insertMany(docs, { session });
    });
    return outcome;
  } catch (error) {
    // A concurrent run inserted the same ids first: the day is written, by them.
    const pattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
    if (isDuplicateKeyError(error) && pattern && 'completionId' in pattern) return 'skipped-existing';
    throw error;
  } finally {
    await session.endSession();
  }
}
