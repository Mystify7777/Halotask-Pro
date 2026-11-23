import Task from '../models/Task.model';
import { isPlainObject, BODY_MUST_BE_OBJECT } from '../utils/requestBody';
import { fingerprintOf } from '../utils/mutationFingerprint';
import {
  CLIENT_KEY_PATTERN,
  createTaskService,
  deleteTaskService,
  updateTaskService,
  type ServiceResult,
} from './taskMutations';
import mongoose from 'mongoose';
import { INVALID_BASE, TASK_FIELD_CONFLICT, type FieldConflict } from '../utils/taskConflict';

// Batched task synchronization (Issue #60): many independent task mutations in one request, one result per mutation.
//
// The batch is NOT atomic and adds no rules of its own. Every mutation runs through the same service the single-task route
// uses (validation, ownership, completion arbitration, Growth award), one after another in request order, and each gets its own
// result. Ordering is therefore the array order; what keeps that order meaningful when something goes wrong is `skipped`: once a
// mutation for a task fails for a reason that leaves its state unknown, the later mutations for that same task are not
// attempted (a later edit must never land before an earlier one that has not). Other tasks carry on.
//
// A PERMANENT refusal (`rejected`) does not block later mutations of the task: the verdict is final and nothing is unknown, so
// the next mutation is judged on its own merits. Only transient failures (`failed`) block.
//
// Idempotency (retrying a mutation never applies it twice), per type:
//   create      the client key (`localId`) is stored on the task under a unique index; a retry finds the task and returns it
//   update      the mutation id and a fingerprint of the change are written in the SAME document write as the change
//               (see updateTaskService); bounded to the last APPLIED_MUTATIONS_WINDOW updates of that task
//   completion  completionId (utils/completionRecords.ts), unchanged
//   delete      deleting a task that is already gone is a success (`alreadyDeleted`)
//
// Ordering across DEVICES is not established here: ordinary fields stay last-write-wins in the order requests reach the server,
// exactly as with the single-task route, EXCEPT for an update that carries `base` (Issue #62, opt-in): then each field it names
// is checked against the value the client expected (utils/taskConflict.ts). A mismatch is answered `conflict`, writes nothing and
// records no marker. A conflict is a final answer about that mutation (nothing is unknown), so it does not block later ones.

export const MAX_SYNC_MUTATIONS = 50;
export const INVALID_SYNC_REQUEST = 'INVALID_SYNC_REQUEST';
export const BLOCKED_BY_EARLIER_MUTATION = 'BLOCKED_BY_EARLIER_MUTATION';

const MUTATION_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;
const SERVER_FAILURE_MESSAGE = 'The server could not apply this change right now.';

type TaskRef = { id: string } | { localId: string };
// `base` (Issue #62) is carried unvalidated until the update service parses it; only an update may have one.
type SyncMutation = { base?: unknown } & (
  | { mutationId: string; type: 'create'; localId: string; payload: Record<string, unknown> }
  | { mutationId: string; type: 'update'; task: TaskRef; payload: Record<string, unknown> }
  | { mutationId: string; type: 'completion'; task: TaskRef; payload: Record<string, unknown> }
  | { mutationId: string; type: 'delete'; task: TaskRef }
);

export type SyncError = { httpStatus?: number; code?: string; message: string; blockedBy?: string };
export type SyncResult =
  | { mutationId: string; status: 'applied'; task?: unknown; growth?: unknown; alreadyDeleted?: true }
  | { mutationId: string; status: 'replayed'; task: unknown }
  | { mutationId: string; status: 'conflict'; conflicts: FieldConflict[]; task: unknown; retryable: false }
  | { mutationId: string; status: 'rejected'; error: SyncError; retryable: false }
  | { mutationId: string; status: 'failed'; error: SyncError; retryable: true }
  | { mutationId: string; status: 'skipped'; error: SyncError; retryable: true };

// One constructor per status, so a result can only carry the fields its status allows.
const applied = (mutationId: string, extra: { task?: unknown; growth?: unknown; alreadyDeleted?: true } = {}): SyncResult => ({
  mutationId,
  status: 'applied',
  ...(extra.task !== undefined ? { task: extra.task } : {}),
  ...(extra.growth !== undefined ? { growth: extra.growth } : {}),
  ...(extra.alreadyDeleted ? { alreadyDeleted: true as const } : {}),
});
const replayed = (mutationId: string, task: unknown): SyncResult => ({ mutationId, status: 'replayed', task });
const conflict = (mutationId: string, conflicts: FieldConflict[], task: unknown): SyncResult => ({ mutationId, status: 'conflict', conflicts, task, retryable: false });
const rejected = (mutationId: string, error: SyncError): SyncResult => ({ mutationId, status: 'rejected', error, retryable: false });
const failed = (mutationId: string, error: SyncError): SyncResult => ({ mutationId, status: 'failed', error, retryable: true });
const skipped = (mutationId: string, blockedBy: string): SyncResult => ({
  mutationId,
  status: 'skipped',
  error: { code: BLOCKED_BY_EARLIER_MUTATION, message: 'An earlier change to the same task has not been applied yet.', blockedBy },
  retryable: true,
});

export type SyncOutcome = { status: number; body: Record<string, unknown> };
const envelopeError = (message: string): SyncOutcome => ({ status: 400, body: { message, code: INVALID_SYNC_REQUEST } });

const parseRef = (value: unknown): TaskRef | null => {
  if (!isPlainObject(value)) return null;
  const { id, localId } = value;
  if (typeof id === 'string' && localId === undefined && id.length > 0 && id.length <= 80) return { id };
  if (typeof localId === 'string' && id === undefined && CLIENT_KEY_PATTERN.test(localId)) return { localId };
  return null;
};

const withBase = (raw: Record<string, unknown>): { base?: unknown } => (raw.base !== undefined ? { base: raw.base } : {});

/** The shape of the request. Anything wrong here fails the WHOLE request: without a usable mutation id there is no result to give. */
const parseRequest = (body: unknown): { ok: true; mutations: SyncMutation[] } | { ok: false; message: string } => {
  if (!isPlainObject(body)) return { ok: false, message: BODY_MUST_BE_OBJECT };
  const list = body.mutations;
  if (!Array.isArray(list)) return { ok: false, message: 'mutations must be an array' };
  if (list.length === 0) return { ok: false, message: 'mutations must not be empty' };
  if (list.length > MAX_SYNC_MUTATIONS) return { ok: false, message: `mutations can hold at most ${MAX_SYNC_MUTATIONS} entries` };

  const seen = new Set<string>();
  const mutations: SyncMutation[] = [];
  for (const [index, raw] of list.entries()) {
    const at = `mutations[${index}]`;
    if (!isPlainObject(raw)) return { ok: false, message: `${at} must be an object` };
    const { mutationId, type } = raw;
    if (typeof mutationId !== 'string' || !MUTATION_ID_PATTERN.test(mutationId)) return { ok: false, message: `${at}.mutationId is invalid` };
    if (seen.has(mutationId)) return { ok: false, message: `${at}.mutationId is repeated in this request` };
    seen.add(mutationId);

    if (type === 'create') {
      if (typeof raw.localId !== 'string' || !CLIENT_KEY_PATTERN.test(raw.localId)) return { ok: false, message: `${at}.localId is invalid` };
      if (!isPlainObject(raw.payload)) return { ok: false, message: `${at}.payload must be an object` };
      mutations.push({ mutationId, type, localId: raw.localId, payload: raw.payload, ...withBase(raw) });
    } else if (type === 'update' || type === 'completion') {
      const task = parseRef(raw.task);
      if (!task) return { ok: false, message: `${at}.task must name a task by id or localId` };
      if (!isPlainObject(raw.payload)) return { ok: false, message: `${at}.payload must be an object` };
      mutations.push({ mutationId, type, task, payload: raw.payload, ...withBase(raw) });
    } else if (type === 'delete') {
      const task = parseRef(raw.task);
      if (!task) return { ok: false, message: `${at}.task must name a task by id or localId` };
      mutations.push({ mutationId, type, task, ...withBase(raw) });
    } else {
      return { ok: false, message: `${at}.type must be create, update, completion or delete` };
    }
  }
  return { ok: true, mutations };
};

const errorOf = (result: ServiceResult): SyncError => {
  const { message, code } = result.body as { message?: unknown; code?: unknown };
  return {
    httpStatus: result.status,
    ...(typeof code === 'string' ? { code } : {}),
    message: typeof message === 'string' ? message : 'The change was refused.',
  };
};

/** Maps a service answer to a result: 2xx applied (or replayed), 4xx a final refusal, anything else a retryable failure. */
const fromService = (mutationId: string, result: ServiceResult): SyncResult => {
  const { task, growth } = result.body;
  if (result.status === 409 && result.body.code === TASK_FIELD_CONFLICT) return conflict(mutationId, result.body.conflicts as FieldConflict[], task);
  if (result.status >= 200 && result.status < 300) {
    return result.replayed ? replayed(mutationId, task) : applied(mutationId, { task, growth });
  }
  return result.status >= 400 && result.status < 500 ? rejected(mutationId, errorOf(result)) : failed(mutationId, errorOf(result));
};

type Resolved = { ok: true; id: string } | { ok: false; missing: boolean; result?: ServiceResult };

const resolveTask = async (userId: string, ref: TaskRef): Promise<Resolved> => {
  if ('id' in ref) {
    return mongoose.Types.ObjectId.isValid(ref.id)
      ? { ok: true, id: ref.id }
      : { ok: false, missing: false, result: { status: 400, body: { message: 'Invalid task id' } } };
  }
  const found = await Task.findOne({ userId, clientKey: ref.localId }, '_id');
  return found ? { ok: true, id: String(found._id) } : { ok: false, missing: true };
};

const keysOf = (ref: TaskRef, resolvedId?: string): string[] => [
  ...('id' in ref ? [`id:${ref.id}`] : [`local:${ref.localId}`]),
  ...(resolvedId ? [`id:${resolvedId}`] : []),
];

export async function executeTaskSync(userId: string, body: unknown): Promise<SyncOutcome> {
  const parsed = parseRequest(body);
  if (!parsed.ok) return envelopeError(parsed.message);

  const results: SyncResult[] = [];
  // task key (`id:<id>` / `local:<localId>`) -> the mutation whose transient failure blocks the later ones
  const blocked = new Map<string, string>();

  const attempt = async (mutation: SyncMutation, keys: { current: string[] }): Promise<SyncResult> => {
    const { mutationId } = mutation;
    // an expected value only means something on an update: refuse it elsewhere instead of silently not checking it
    if (mutation.base !== undefined && mutation.type !== 'update') {
      return rejected(mutationId, { httpStatus: 400, code: INVALID_BASE, message: 'base is only allowed on an update.' });
    }
    const blockerOf = (list: string[]) => list.map((key) => blocked.get(key)).find((id) => id !== undefined);
    const skippedBy = (blocker: string) => skipped(mutationId, blocker);

    if (mutation.type === 'create') {
      const blocker = blockerOf(keys.current);
      if (blocker) return skippedBy(blocker);
      return fromService(mutationId, await createTaskService(userId, { ...mutation.payload, clientKey: mutation.localId }));
    }

    const earlier = blockerOf(keys.current);
    if (earlier) return skippedBy(earlier);

    const resolved = await resolveTask(userId, mutation.task);
    if (!resolved.ok) {
      // A delete of a task that does not exist is done. Everything else needs the task.
      if (mutation.type === 'delete' && resolved.missing) return applied(mutationId, { alreadyDeleted: true });
      return resolved.result ? fromService(mutationId, resolved.result) : rejected(mutationId, { httpStatus: 404, message: 'Task not found' });
    }

    // The same task can be named by its local id and by its id: a failure under one name blocks both.
    keys.current = keysOf(mutation.task, resolved.id);
    const viaId = blockerOf(keys.current);
    if (viaId) return skippedBy(viaId);

    if (mutation.type === 'update') {
      return fromService(
        mutationId,
        await updateTaskService(userId, resolved.id, mutation.payload, {
          // the fingerprint covers the expected values too, but only when there are some, so every mutation without `base` keeps its #60 fingerprint
          mutation: { id: mutationId, fp: fingerprintOf(mutation.base === undefined ? mutation.payload : { payload: mutation.payload, base: mutation.base }) },
          ...(mutation.base !== undefined ? { base: mutation.base } : {}),
        }),
      );
    }
    if (mutation.type === 'completion') {
      const { completed, completionEvent } = mutation.payload;
      if (typeof completed !== 'boolean' || !isPlainObject(completionEvent)) {
        return rejected(mutationId, { httpStatus: 400, message: 'A completion needs completed (boolean) and a completionEvent.' });
      }
      return fromService(mutationId, await updateTaskService(userId, resolved.id, { completed, completionEvent }));
    }
    const service = await deleteTaskService(userId, resolved.id);
    return service.status === 404 ? applied(mutationId, { alreadyDeleted: true }) : fromService(mutationId, service);
  };

  for (const mutation of parsed.mutations) {
    const keys = { current: keysOf(mutation.type === 'create' ? { localId: mutation.localId } : mutation.task) };
    let result: SyncResult;
    try {
      result = await attempt(mutation, keys);
    } catch (error) {
      // A genuine server error: nothing is known about this change, so it is retryable and blocks its task's later changes.
      console.error('[TaskSync] A mutation failed unexpectedly:', mutation.type, error);
      result = failed(mutation.mutationId, { message: SERVER_FAILURE_MESSAGE });
    }
    results.push(result);
    // One place decides what blocks: a transient failure blocks the task's later mutations under every name it was given (its
    // local id and its id), so the block cannot be sidestepped by naming the task another way. A skipped mutation adds nothing:
    // whatever blocked it is already recorded.
    if (result.status === 'failed') for (const key of keys.current) blocked.set(key, mutation.mutationId);
  }

  return { status: 200, body: { results } };
}
