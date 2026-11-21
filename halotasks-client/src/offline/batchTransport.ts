import { taskService } from '../services/taskService';
import type { BoundSession } from '../services/api';
import { httpStatusOf } from './deliveryErrors';
import { INVALID_SYNC_REQUEST, MAX_BATCH_MUTATIONS, type SyncMutation, type SyncResult } from './batchProtocol';

/**
 * Sends the queue's mutations in batches (Issue #60) and hands each queue entry its own answer, in the SAME shape the
 * single-task request would have produced: a response object when it was applied, a thrown error when it was not. That is the
 * whole integration point: the processor loop that walks the queue entry by entry (callbacks, stale-answer checks, the
 * due-time recovery, the completion fallback, `settleSyncQueue`) is unchanged, it just asks this transport for the answer of an
 * entry instead of making its own request.
 *
 *  - `applied` / `replayed`  -> the response (`{ task, growth }`; a replay carries `replayed: true`; a delete resolves with nothing)
 *  - `rejected`              -> an error with `response.status` and `response.data.code`, so `isPermanentError` and the
 *                               409/404 recoveries see exactly what a single request's failure looked like
 *  - `failed` / `skipped`    -> an error with NO response (the server may not have applied it; kept and retried later)
 *  - a request that failed as a whole (network, 401, 5xx, 429, a changed session) -> that very error, for every entry of it
 *
 * Batches are sent one after another in queue order. Once one comes back with something unapplied (a failure or a skipped
 * mutation), or fails as a whole, NO later batch is sent: a later edit of the same task must never reach the server ahead of
 * an earlier one that has not. Those entries stay queued (answered with a retryable error).
 *
 * The batch route is optional. A server that does not have it (404/405) switches batching off for the rest of the page's
 * life; a request the server refuses as malformed (400 INVALID_SYNC_REQUEST, which would be a client bug) switches it off for
 * this run only. In both cases the entries get no answer here and the loop falls back to the single-task requests, one per entry.
 */

export type PlannedMutation = { entryId: string; mutation: SyncMutation };

export type BatchTransport = {
  /**
   * Whether this entry's answer is already in hand (its request has been made). Using such an answer sends nothing, so it needs
   * no check of who is signed in: the request went out as the owner, and what the server confirmed is the owner's to settle.
   */
  holds: (entryId: string) => boolean;
  /** The entry's answer, or `fallback()` (the single-task request) when it was not sent in a batch. */
  answer: <T>(entryId: string, fallback: () => Promise<T>) => Promise<T>;
};

type Outcome = { kind: 'result'; result: SyncResult } | { kind: 'error'; error: unknown };

/** Keeps a request comfortably under the server's 1 MB body limit (the envelope and headers are not counted here). */
const MAX_BATCH_BYTES = 700_000;

let batchSupported = true;
/** Tests only: a new page lifetime. */
export const resetBatchSupport = (): void => {
  batchSupported = true;
};

const errorCodeOf = (error: unknown): string | null => {
  const body = (error as { response?: { data?: unknown } })?.response?.data;
  const code = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
};

/** An error as a single failed request would have thrown it (see httpStatusOf / errorCodeOf in the processor). */
const refusal = (status: number, message: string, code?: string): Error =>
  Object.assign(new Error(message), { response: { status, data: { message, ...(code ? { code } : {}) } } });

/** An error with no response at all: neither a refusal nor an auth problem, so the entry is kept and the run reports `unreachable`. */
const notApplied = (message: string): Error => new Error(message);

export const chunkPlan = (plan: PlannedMutation[]): PlannedMutation[][] => {
  const chunks: PlannedMutation[][] = [];
  let current: PlannedMutation[] = [];
  let bytes = 0;
  for (const item of plan) {
    const size = JSON.stringify(item.mutation).length;
    if (current.length > 0 && (current.length >= MAX_BATCH_MUTATIONS || bytes + size > MAX_BATCH_BYTES)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

type ChunkOutcome = { stop: boolean; fallback: boolean };

const sendChunk = async (chunk: PlannedMutation[], outcomes: Map<string, Outcome>, session: BoundSession): Promise<ChunkOutcome> => {
  try {
    const data = await taskService.syncBatch(
      chunk.map((item) => item.mutation),
      { session },
    );
    const results = data?.results;
    const wellFormed =
      Array.isArray(results) && results.length === chunk.length && results.every((result, index) => result?.mutationId === chunk[index].mutation.mutationId);
    if (!wellFormed) {
      console.warn('[syncQueue] The batch answer did not match the request; sending one request per entry instead.');
      return { stop: false, fallback: true };
    }
    chunk.forEach((item, index) => outcomes.set(item.entryId, { kind: 'result', result: results[index] }));
    return { stop: results.some((result) => result.status === 'failed' || result.status === 'skipped'), fallback: false };
  } catch (error) {
    const status = httpStatusOf(error);

    if (status === 413) {
      if (chunk.length === 1) {
        // One mutation is too big for any request: it can never be sent, so it is refused for good like any other 4xx.
        outcomes.set(chunk[0].entryId, {
          kind: 'result',
          result: { mutationId: chunk[0].mutation.mutationId, status: 'rejected', retryable: false, error: { httpStatus: 413, message: 'The change is too large to send.' } },
        });
        return { stop: false, fallback: false };
      }
      const half = Math.ceil(chunk.length / 2);
      const first = await sendChunk(chunk.slice(0, half), outcomes, session);
      if (first.stop || first.fallback) return first;
      return sendChunk(chunk.slice(half), outcomes, session);
    }

    if (status === 404 || status === 405) {
      console.warn('[syncQueue] This server has no batch endpoint; sending one request per entry.');
      batchSupported = false;
      return { stop: false, fallback: true };
    }

    if (status === 400 && errorCodeOf(error) === INVALID_SYNC_REQUEST) {
      console.warn('[syncQueue] The server refused the batch as malformed; sending one request per entry for this run.', error);
      return { stop: false, fallback: true };
    }

    // Anything else (network, timeout, 401, 429, 5xx, a changed session) is a statement about the whole request: every
    // entry in it gets this error, and the run's usual classification applies to the first of them.
    chunk.forEach((item) => outcomes.set(item.entryId, { kind: 'error', error }));
    return { stop: true, fallback: false };
  }
};

export const createBatchTransport = async (plan: PlannedMutation[], session: BoundSession): Promise<BatchTransport> => {
  const outcomes = new Map<string, Outcome>();

  if (batchSupported && plan.length > 0) {
    const chunks = chunkPlan(plan);
    for (const [index, chunk] of chunks.entries()) {
      const { stop, fallback } = await sendChunk(chunk, outcomes, session);
      if (fallback) break; // the rest go one by one, still in order (the loop is sequential)
      if (stop) {
        // Not sent, so not applied; the entries wait (see the note on ordering above).
        for (const later of chunks.slice(index + 1).flat()) {
          outcomes.set(later.entryId, { kind: 'error', error: notApplied('An earlier batch was not fully applied; this change waits for the next run.') });
        }
        break;
      }
    }
  }

  return {
    holds: (entryId) => outcomes.has(entryId),
    answer: async <T>(entryId: string, fallback: () => Promise<T>): Promise<T> => {
      const outcome = outcomes.get(entryId);
      if (!outcome) return fallback();
      if (outcome.kind === 'error') throw outcome.error;

      const { result } = outcome;
      switch (result.status) {
        case 'applied':
          return { task: result.task, ...(result.growth !== undefined ? { growth: result.growth } : {}) } as T;
        case 'replayed':
          return { task: result.task, replayed: true } as T;
        case 'rejected':
          throw refusal(result.error.httpStatus ?? 400, result.error.message, result.error.code);
        default:
          throw notApplied(result.error.message);
      }
    },
  };
};

/**
 * The part of a create's payload the server's task already holds. A create that comes back as a REPLAY was applied by an
 * earlier request; the entry may have changed since (an edit merged into it, rule 1 of the queue contract), so the answer says
 * nothing about the newer fields. Whatever differs is left out of what counts as "sent", and `settleSyncQueue` queues exactly
 * those fields as an update to the task. Completion fields are never part of that update (a completion is its own event).
 */
export const payloadAppliedBy = (serverTask: unknown, payload: Record<string, unknown> | undefined): Record<string, unknown> => {
  const stored = (typeof serverTask === 'object' && serverTask !== null ? serverTask : {}) as Record<string, unknown>;
  const applied: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload ?? {})) {
    const isCompletionField = key === 'completed' || key === 'completionEvent' || key === 'completedAt' || key === 'completionId';
    if (isCompletionField || JSON.stringify(stored[key]) === JSON.stringify(value)) applied[key] = value;
  }
  return applied;
};
