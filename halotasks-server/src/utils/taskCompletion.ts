import Task from '../models/Task.model';
import type { GrowthResult } from './treeRules';
import { COMPLETION_TASK_MISMATCH, type TaskCompletionEvent } from './completionValidators';
import {
  findCompletion,
  inspectEvent,
  newServerCompletionId,
  recordOwnedCompletion,
  recordSupersededCompletion,
  revokeCompletion,
  type CompletionInput,
  type EventInspection,
  type OwnedCompletion,
  type RecordResult,
  type RevokeResult,
} from './completionRecords';

// -- Task completion transitions (Issue #47, Phase 1B) --
//
// THE INVARIANT. A task's completion state is `completed` + `completionId` (which completion it currently holds), written
// together in ONE document write. That write is CONDITIONAL on the state the request read:
//     complete:   completed is false AND completionId is what was read
//     uncomplete: completed is true  AND completionId is what was read
// MongoDB serialises writes to a single document, so of two opposing transitions that read the same state exactly one
// commits; the other's condition no longer holds, it reloads and decides again. The records FOLLOW the committed task:
//     committed task state                      records
//     completed, completionId = C               C is active, every other record of the task is revoked
//     not completed                             no record of the task is active
// "Follow" is asynchronous (a second write), so the state can be briefly behind; it always converges, because every step is
// idempotent, a request only revokes the exact completion its own commit ended, a record never goes back to active, and a
// record inserted after the task moved on is revoked by its own request (the ownership re-check in recordOwnedCompletion).
//
// REWARD ORDER. The Growth Tree ledger is keyed by task id and never reversed, so it must not run for a request that can still
// lose. The order is therefore  task arbitration -> completion record -> convergence check -> award:
//   - the award runs only after this request's conditional write committed (or the request is the retry of one that did), and
//     only if the task STILL holds that completion once the record is settled. A completion that loses the arbitration, is
//     superseded, is refused, or is taken back by the convergence check never reaches the award;
//   - if the award fails, the task already holds the completion: the request fails (5xx) and the retry, finding the task
//     completed with the same completionId, only has to finish the idempotent award (and the record, if it is missing);
//   - consistency of the task and its records is one guarantee; reward consistency is another: "the ledger has the task
//     iff some request committed a completion of it and finished", the ledger itself being idempotent and permanent.
//
// REFUSED EVENTS. An event-bearing request whose event is refused (id reused for another event, time outside the window,
// a revoke naming another task's completion) changes NOTHING: no task write, no record, no award, HTTP 400 with a code.
// The invariant has no exception for them. A request without an event (a legacy client) is never refused.
//
// A legacy client sends `completed: false` with no completion id. It is BEST EFFORT: it uncompletes whatever the task holds
// when the request arrives and revokes exactly that completion. Only a client that names the completion it means (a
// retried "uncomplete C1") can be told apart from "uncomplete whatever is there", and only that one is safe against a
// newer completion.

export type TaskState = { completed: boolean; completionId?: string | null };

export type TransitionTask = TaskState & Record<string, unknown>;

/** `refused`: the completion event was refused (code), so NOTHING was changed (or a commit was taken back): the caller answers 400. */
type Attempt = { task: unknown; result?: RecordResult | RevokeResult; growth?: GrowthResult; refused?: string };

export type TransitionParams = {
  userId: string;
  taskId: string;
  current: TaskState;
  /** The `completed` value the request asks for; undefined when it does not touch completion. */
  desired: boolean | undefined;
  event: TaskCompletionEvent | undefined;
  snapshot: { titleSnapshot: string; estimatedMinutesSnapshot: number };
  /**
   * The Growth Tree award: idempotent by task id and NOT reversible, so it runs only AFTER this request's completion is committed
   * on the task and its record is settled, and only while the task still holds that completion (see the header).
   */
  award: () => Promise<GrowthResult | undefined>;
  /** Read-only: does the award still have work to do (task not in the ledger, or its derived copy stale)? */
  awardPending: () => Promise<boolean>;
  /**
   * Writes the request's fields with `extraFilter` added to the task filter and `completionSet` merged into the $set.
   * Returns the updated task, or null when the filter missed.
   */
  write: (extraFilter: Record<string, unknown>, completionSet: Record<string, unknown>) => Promise<unknown | null>;
};

const MAX_TRANSITION_ATTEMPTS = 3;

const pointerOf = (state: TaskState): string | null => state.completionId ?? null;

/** True while `completionId` is the completion the task currently holds. Re-read each time: it is the ownership check. */
export const taskOwnsCompletion = async (userId: string, taskId: string, completionId: string): Promise<boolean> => {
  const latest = await Task.findOne({ _id: taskId, userId }).lean();
  const state = latest as unknown as TaskState | null;
  return Boolean(state && state.completed === true && state.completionId === completionId);
};

const inputOf = (p: TransitionParams, event: Extract<TaskCompletionEvent, { kind: 'complete' }>): CompletionInput => ({
  ...p.snapshot,
  taskId: p.taskId,
  completionId: event.completionId,
  completedAt: event.completedAt,
  utcOffsetMinutes: event.utcOffsetMinutes,
  localDate: event.localDate,
});

/**
 * Applies the request's write (and its completion transition, if any). Returns `task: null` when the write could not be
 * applied for a reason that is not about completion (the caller owns that answer, e.g. the stored due date went away).
 */
export async function applyTaskWrite(p: TransitionParams): Promise<Attempt> {
  let growth: GrowthResult | undefined;
  let cur: TaskState = p.current;
  const serverId = newServerCompletionId();

  for (let attempt = 0; attempt < MAX_TRANSITION_ATTEMPTS; attempt += 1) {
    if (attempt > 0) {
      const reloaded = await Task.findOne({ _id: p.taskId, userId: p.userId }).lean();
      if (!reloaded) return { task: null };
      cur = reloaded as unknown as TaskState;
    }
    const step = await stepOnce(p, cur, serverId);
    if (step.kind === 'refused') return { task: null, refused: step.code };
    if (step.kind === 'done') {
      let task = step.task;
      let repaired = false;
      for (const id of new Set(step.ids ?? [])) repaired = (await reconcileCompletion(p.userId, p.taskId, id)) || repaired;
      if (repaired) task = (await Task.findOne({ _id: p.taskId, userId: p.userId })) ?? task;
      // A record refused AFTER the commit (the id turned out to belong to another event): the convergence check took the
      // commit back, so the request is refused like any other refused event.
      if (step.result?.outcome === 'rejected' && step.result.code) return { task: null, refused: step.result.code };
      // The reward: only for the completion this request owns, and only if the task still holds it now.
      if (step.awardFor) {
        const latest = (await Task.findOne({ _id: p.taskId, userId: p.userId }).lean()) as unknown as TaskState | null;
        if (latest && latest.completed === true && latest.completionId === step.awardFor) {
          // the request that committed always awards; a retry of a commit only if there is something left to do
          if (step.committed || (await p.awardPending())) growth = await p.award();
        }
      }
      return { task, result: step.result, ...(growth ? { growth } : {}) };
    }

    // The conditional write missed. Reload and look: did the completion state move, or did another condition fail?
    const latest = await Task.findOne({ _id: p.taskId, userId: p.userId }).lean();
    if (!latest) return { task: null };
    const state = latest as unknown as TaskState;
    if (state.completed === cur.completed && pointerOf(state) === pointerOf(cur)) return { task: null };
    cur = state;
    // loop: decide again against the new state (the next iteration reloads once more, which is cheap and keeps it simple)
  }
  throw new Error('The task kept changing while it was being updated; retry the request.');
}

type Step =
  | { kind: 'done'; task: unknown; result?: RecordResult | RevokeResult; ids?: string[]; awardFor?: string; committed?: boolean }
  | { kind: 'refused'; code: string }
  | { kind: 'retry' };

async function stepOnce(p: TransitionParams, cur: TaskState, serverId: string): Promise<Step> {
  const { userId, taskId, desired, event } = p;
  // every completion id this step looked at or wrote: each is checked for convergence before the request answers
  const touched: string[] = [...(event?.completionId ? [event.completionId] : []), ...(pointerOf(cur) ? [pointerOf(cur) as string] : [])];
  const plain = async (result?: RecordResult | RevokeResult, awardFor?: string): Promise<Step> => {
    const task = await p.write({}, {});
    return { kind: 'done', task, result, ids: touched, ...(awardFor ? { awardFor } : {}) };
  };

  if (desired === undefined) return plain();

  // ---------------------------------------------------------------- complete
  if (desired === true) {
    const clientEvent = event?.kind === 'complete' ? event : undefined;

    // A refused event changes nothing at all (see the header): decide that before any write, whatever the task's state.
    let inspected: EventInspection = { kind: 'new' };
    if (clientEvent) {
      inspected = await inspectEvent(userId, inputOf(p, clientEvent));
      if (inspected.kind === 'refused') return { kind: 'refused', code: inspected.code };
    }

    if (cur.completed) {
      // Already completed: a retry of the commit, a second device that lost, or a legacy no-op.
      if (clientEvent) {
        if (pointerOf(cur) === clientEvent.completionId) {
          const result = await recordOwnedCompletion(
            userId,
            { fidelity: 'client', ...inputOf(p, clientEvent) },
            () => taskOwnsCompletion(userId, taskId, clientEvent.completionId),
          );
          // the retry of a commit: the reward may be the step that failed, so it is (idempotently) finished here
          return plain(result, clientEvent.completionId);
        }
        return plain(await recordSupersededCompletion(userId, inputOf(p, clientEvent)));
      }
      const held = pointerOf(cur);
      if (held && held.startsWith('srv-')) {
        // A legacy retry: the commit happened, the server-observed record may not have. Writing it again is idempotent.
        const result = await recordOwnedCompletion(
          userId,
          { fidelity: 'server', completionId: held, taskId, ...p.snapshot },
          () => taskOwnsCompletion(userId, taskId, held),
        );
        return plain(result, held);
      }
      return plain();
    }

    // Not completed: this request may commit the transition.
    let owned: OwnedCompletion;
    if (clientEvent) {
      const input = inputOf(p, clientEvent);
      if (inspected.kind === 'stored') {
        // Processed before (e.g. a stale retry after an uncomplete): it never completes the task again. Close it if needed.
        const result = await recordOwnedCompletion(userId, { fidelity: 'client', ...input }, async () => false);
        return plain(result);
      }
      owned = { fidelity: 'client', ...input };
    } else {
      owned = { fidelity: 'server', completionId: serverId, taskId, ...p.snapshot };
    }

    // 1. task arbitration
    const task = await p.write(
      { completed: false, completionId: pointerOf(cur) },
      { completed: true, completedAt: new Date(), completionId: owned.completionId },
    );
    if (!task) return { kind: 'retry' };

    // 2. the record follows the committed task
    const result = await recordOwnedCompletion(userId, owned, () => taskOwnsCompletion(userId, taskId, owned.completionId));
    if (result.outcome === 'rejected' && result.code) {
      // Refused only now (the id turned out to belong to another event): the commit is taken back, nothing is awarded.
      await Task.findOneAndUpdate(
        { _id: taskId, userId, completed: true, completionId: owned.completionId },
        { $set: { completed: false, completedAt: null } },
      );
      return { kind: 'refused', code: result.code };
    }
    // 3. the convergence check and 4. the award happen in applyTaskWrite, in that order
    return { kind: 'done', task, result, ids: [...touched, owned.completionId], awardFor: owned.completionId, committed: true };
  }

  // -------------------------------------------------------------- uncomplete
  const named = event?.kind === 'revoke' && event.completionId ? event.completionId : undefined;
  const revokedAt = event?.kind === 'revoke' ? event.revokedAt : null;
  const revokeExact = (completionId: string) => revokeCompletion(userId, { taskId, completionId, revokedAt });

  // A revoke that names another task's completion is refused before anything is written.
  if (named) {
    const stored = await findCompletion(userId, named);
    if (stored && stored.taskId !== taskId) return { kind: 'refused', code: COMPLETION_TASK_MISMATCH };
  }

  if (!cur.completed) {
    // Already not completed (a retry, or the other device got there first): finish the revocation of what it held.
    const target = named ?? pointerOf(cur);
    return plain(target ? await revokeExact(target) : undefined);
  }

  const held = pointerOf(cur);
  if (named && held && named !== held) {
    // A stale "uncomplete C1" while the task holds a newer completion: it must not undo the newer one.
    const result = await revokeExact(named);
    return plain(result);
  }

  const task = await p.write(
    { completed: true, completionId: held },
    { completed: false, completedAt: null },
  );
  if (!task) return { kind: 'retry' };
  const target = held ?? named;
  return { kind: 'done', task, result: target ? await revokeExact(target) : undefined, ids: touched };
}

/**
 * CONVERGENCE CHECK, run by a request for every completion id it touched, after its last write. The task and the record are
 * two documents, so two requests can interleave between "look" and "act" (a duplicate of an event commits on the task just
 * after its twin was revoked; a revoke runs on an ownership check that is a moment old). Whoever makes the LAST mutation
 * then reads the final state here and repairs the one disagreement that can exist:
 *  - the task holds C but C's record is revoked: a record never goes back to active, so the task's commit is taken back
 *    (conditional on the task still holding exactly C, so it cannot undo anything newer);
 *  - the task holds C but C's record belongs to another task (the id was reused): the commit is taken back too (there is
 *    no completed task without its record);
 *  - the task does not hold C but C's record is active: it is revoked by its exact id.
 * Each repair is followed by another look (at most 3), so the loop ends only at a state with no disagreement.
 * Returns true when it changed anything, so the caller can re-read the task it answers with.
 */
async function reconcileCompletion(userId: string, taskId: string, completionId: string): Promise<boolean> {
  let changed = false;
  for (let round = 0; round < 3; round += 1) {
    const [taskRow, record] = await Promise.all([Task.findOne({ _id: taskId, userId }).lean(), findCompletion(userId, completionId)]);
    const task = taskRow as unknown as TaskState | null;
    if (!task || !record) return changed;
    const holds = task.completed === true && task.completionId === completionId;

    if (holds && record.taskId !== taskId) {
      await Task.findOneAndUpdate({ _id: taskId, userId, completed: true, completionId }, { $set: { completed: false, completedAt: null } });
    } else if (holds && record.status === 'revoked') {
      await Task.findOneAndUpdate({ _id: taskId, userId, completed: true, completionId }, { $set: { completed: false, completedAt: null } });
    } else if (!holds && record.status === 'active' && record.taskId === taskId) {
      await revokeCompletion(userId, { taskId, completionId, revokedAt: null });
    } else {
      return changed;
    }
    changed = true;
  }
  return changed;
}
