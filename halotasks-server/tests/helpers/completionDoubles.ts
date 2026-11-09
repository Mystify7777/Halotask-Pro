import { vi } from 'vitest';

// An in-memory stand-in for the CompletionRecord model (Issue #47), for tests that need MongoDB's observable behaviour
// without a MongoDB (the sandbox cannot download MongoMemoryServer's binary).
//
// FIDELITY RULES — deliberately strict, so the double cannot be more forgiving than MongoDB:
//   * every operation is applied ATOMICALLY: match + apply happen in one synchronous block, after the (optional) async
//     `hooks.before*`, like a single-document write on the server. The hooks are how a test interleaves two requests;
//   * the two UNIQUE indexes of the real model are enforced on insert, and a violation throws an error shaped like the
//     driver's (`code: 11000`, `keyPattern`):
//         (userId, completionId)                                       the idempotency key
//         (userId, taskId) where status 'active' AND source 'live'      the single active slot of a task
//   * only the operations the service uses exist ($set updates, equality filters). Anything else THROWS, so a change that
//     starts using another operator fails here loudly instead of being quietly accepted.
//
// What this double cannot prove (that the real indexes exist, that the real driver raises 11000 for them, real
// concurrency) is covered by tests/completionRecord.realmongo.test.ts, which needs a MongoDB binary.

type Doc = Record<string, unknown>;
type Filter = Record<string, unknown>;

export type CompletionStore = {
  docs: Doc[];
  ops: string[];
  hooks: {
    /** Awaited before an insert is attempted (interleave a rival request here). */
    beforeCreate?: (doc: Doc) => Promise<void>;
    /** Return an error to make the next matching insert fail (database fault). */
    failCreate?: (doc: Doc) => Error | null;
    /** Return an error to make a lookup fail. */
    failFind?: (filter: Filter) => Error | null;
    /** Return an error to make an update (revoke) fail. */
    failUpdate?: (filter: Filter, update: Doc) => Error | null;
    /** Awaited at the start of every operation: a seeded scheduler shuffles concurrent requests here. */
    delay?: (op: 'findOne' | 'create' | 'findOneAndUpdate' | 'find') => Promise<void> | void;
    /** A standalone server: startSession() works but starting a transaction is refused (nothing is written). */
    standalone?: boolean;
    /** Return an error to make the COMMIT of a transaction fail (everything done inside it is rolled back). */
    failCommit?: () => Error | null;
  };
};

export const createCompletionStore = (): CompletionStore => ({ docs: [], ops: [], hooks: {} });

const clone = <T>(value: T): T => structuredClone(value);

const duplicateKeyError = (keyPattern: Record<string, number>): Error =>
  Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern });

const SUPPORTED = new Set(['userId', 'completionId', 'taskId', 'status', 'source']);

const matches = (doc: Doc, filter: Filter): boolean =>
  Object.entries(filter).every(([key, expected]) => {
    if (!SUPPORTED.has(key)) throw new Error(`completionDoubles: unsupported filter field ${key}`);
    if (typeof expected === 'object' && expected !== null) throw new Error(`completionDoubles: unsupported filter operator on ${key}`);
    return String(doc[key]) === String(expected);
  });

const query = <T>(run: () => Promise<T>) => {
  const q = {
    lean: () => q,
    select: () => q,
    session: () => q,
    then: (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject),
  };
  return q;
};

/** One synchronous block: check the two unique indexes, then insert (the atomic step of a single-document insert). */
const insertChecked = (store: CompletionStore, input: Doc): Doc => {
  if (store.docs.some((doc) => String(doc.userId) === String(input.userId) && doc.completionId === input.completionId)) {
    throw duplicateKeyError({ userId: 1, completionId: 1 });
  }
  if (
    input.status === 'active' &&
    input.source === 'live' &&
    store.docs.some(
      (doc) =>
        String(doc.userId) === String(input.userId) && doc.taskId === input.taskId && doc.status === 'active' && doc.source === 'live',
    )
  ) {
    throw duplicateKeyError({ userId: 1, taskId: 1 });
  }
  const doc = clone(input);
  store.docs.push(doc);
  return clone(doc);
  };

export const completionRecordDouble = (store: CompletionStore) => ({
  findOne: (filter: Filter) =>
    query(async () => {
      store.ops.push('findOne');
      await store.hooks.delay?.('findOne');
      const fault = store.hooks.failFind?.(filter);
      if (fault) throw fault;
      const found = store.docs.find((doc) => matches(doc, filter));
      return found ? clone(found) : null;
    }),

  // Reads for history (Phase 2A): { userId, localDate: { $in: [...] } } is the only shape the history read uses.
  find: (filter: Filter) =>
    query(async () => {
      store.ops.push('find');
      await store.hooks.delay?.('find');
      const { localDate, ...rest } = filter as Filter & { localDate?: { $in: string[] } };
      const days = localDate && typeof localDate === 'object' ? (localDate as { $in: string[] }).$in : null;
      if (!days) throw new Error('completionDoubles: find supports only { localDate: { $in } }');
      return store.docs.filter((doc) => matches(doc, rest) && doc.localDate != null && days.includes(doc.localDate as string)).map(clone);
    }),

  create: async (input: Doc) => {
    store.ops.push('create');
    await store.hooks.delay?.('create');
    await store.hooks.beforeCreate?.(input);
    const fault = store.hooks.failCreate?.(input);
    if (fault) throw fault;

    return insertChecked(store, input);
  },

  /** Mongoose Model.insertMany: ordered, stops at the first failure. Atomic ONLY inside a transaction (session). */
  insertMany: async (inputs: Doc[], options: { session?: { written?: Doc[] } } = {}) => {
    store.ops.push('insertMany');
    const out: Doc[] = [];
    for (const input of inputs) {
      await store.hooks.delay?.('create');
      await store.hooks.beforeCreate?.(input);
      const fault = store.hooks.failCreate?.(input);
      if (fault) throw fault;
      const stored = insertChecked(store, input);
      options.session?.written?.push(store.docs[store.docs.length - 1]); // what a rollback must take back
      out.push(stored);
    }
    return out;
  },

  /** Model.startSession(): withTransaction applies fn, and rolls EVERYTHING it wrote back if fn (or the commit) throws. */
  startSession: async () => {
    // Rollback removes ONLY what this transaction wrote (a concurrent transaction's committed records stay), like a real one.
    const session = {
      written: [] as Doc[],
      withTransaction: async (fn: () => Promise<void>) => {
        if (store.hooks.standalone) throw Object.assign(new Error('Transaction numbers are only allowed on a replica set member or mongos'), { code: 20 });
        session.written = [];
        try {
          await fn();
          const commitFault = store.hooks.failCommit?.();
          if (commitFault) throw commitFault;
        } catch (error) {
          for (const doc of session.written) {
            const at = store.docs.indexOf(doc);
            if (at >= 0) store.docs.splice(at, 1);
          }
          throw error;
        }
      },
      endSession: async () => undefined,
    };
    return session;
  },

  findOneAndUpdate: (filter: Filter, update: { $set?: Doc }) =>
    query(async () => {
      store.ops.push('findOneAndUpdate');
      await store.hooks.delay?.('findOneAndUpdate');
      const updateFault = store.hooks.failUpdate?.(filter, update as Doc);
      if (updateFault) throw updateFault;
      const keys = Object.keys(update);
      if (keys.some((key) => key !== '$set')) throw new Error('completionDoubles: only $set updates are supported');
      const found = store.docs.find((doc) => matches(doc, filter));
      if (!found) return null;
      Object.assign(found, clone(update.$set ?? {}));
      return clone(found);
    }),

  deleteOne: async (filter: Filter) => {
    store.ops.push('deleteOne');
    const index = store.docs.findIndex((doc) => matches(doc, filter));
    if (index >= 0) store.docs.splice(index, 1);
    return { deletedCount: index >= 0 ? 1 : 0 };
  },
});

/** Replaces the CompletionRecord model for the next dynamic import of the app (call before importing it). */
export const installCompletionRecordMock = (store: CompletionStore): void => {
  vi.doMock('../../src/models/CompletionRecord.model', () => ({ default: completionRecordDouble(store) }));
};

export const removeCompletionRecordMock = (): void => {
  vi.doUnmock('../../src/models/CompletionRecord.model');
};
