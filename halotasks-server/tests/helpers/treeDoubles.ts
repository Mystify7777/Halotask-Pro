import { vi } from 'vitest';
import type { Express } from 'express';
import { createCompletionStore, installCompletionRecordMock, removeCompletionRecordMock, type CompletionStore } from './completionDoubles';

// In-memory stand-ins for the User and Task models, for tests that need MongoDB's observable behaviour
// without a MongoDB (the sandbox cannot download MongoMemoryServer's binary).
//
// FIDELITY RULES — the doubles are deliberately strict so they cannot be more forgiving than MongoDB:
//   * every operation is applied ATOMICALLY: match + apply happen in one synchronous block, after the
//     (optional) async `hooks.before`, exactly like a single-document update on the server;
//   * only the operators the Growth Tree code uses are supported ($ne, $exists, $gte, $lte on filters;
//     $type:'array' and a top-level $or on filters; $inc, $push, $addToSet, $set, $unset on updates). Anything else THROWS, so a change that starts using another
//     operator fails here loudly instead of being quietly accepted;
//   * matching follows MongoDB's rules: `null` matches a missing or null field, `$ne` matches when no
//     array element equals the value (or the field is missing), `$gte`/`$lte` only match numbers
//     (type bracketing), `$exists:false` on `arr.<n>` means "no element at index n".

type Doc = Record<string, unknown>;
export type Filter = Record<string, unknown>;
export type Update = Record<string, Record<string, unknown>>;

export type StoreOp = { op: string; filter: Filter; update?: Update };

/** A thenable with `.lean()` / `.select()` that runs `run` when awaited — what the controllers `await`. */
const query = <T>(run: () => Promise<T>) => {
  const q = {
    lean: () => q,
    select: () => q,
    then: (resolve: (value: T) => unknown, reject?: (reason: unknown) => unknown) => run().then(resolve, reject),
  };
  return q;
};

const clone = <T>(value: T): T => structuredClone(value);

const getPath = (doc: Doc, path: string): unknown => {
  let current: unknown = doc;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      const index = Number(part);
      // `array.0` is an element; `array.field` is the field of every element (how a MongoDB path through an array behaves)
      current = Number.isInteger(index) ? current[index] : current.map((item) => (typeof item === 'object' && item !== null ? (item as Doc)[part] : undefined));
    } else if (typeof current === 'object') {
      current = (current as Doc)[part];
    } else {
      return undefined;
    }
  }
  return current;
};

const setPath = (doc: Doc, path: string, value: unknown): void => {
  const parts = path.split('.');
  let current = doc;
  for (const part of parts.slice(0, -1)) {
    if (typeof current[part] !== 'object' || current[part] === null) current[part] = {};
    current = current[part] as Doc;
  }
  current[parts[parts.length - 1]] = value;
};

const unsetPath = (doc: Doc, path: string): void => {
  const parts = path.split('.');
  let current: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    if (typeof current !== 'object' || current === null) return;
    current = (current as Doc)[part];
  }
  if (typeof current === 'object' && current !== null) delete (current as Doc)[parts[parts.length - 1]];
};

const isOperatorObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).some((k) => k.startsWith('$'));

const equalsValue = (actual: unknown, expected: unknown): boolean => {
  if (expected === null) return actual === null || actual === undefined;
  if (Array.isArray(actual) && !Array.isArray(expected)) return actual.some((item) => Object.is(item, expected));
  return Object.is(actual, expected);
};

const matchesField = (actual: unknown, condition: unknown): boolean => {
  if (!isOperatorObject(condition)) return equalsValue(actual, condition);

  return Object.entries(condition).every(([operator, operand]) => {
    switch (operator) {
      case '$ne':
        // Matches when the field is missing, or no array element / scalar equals the operand.
        return !equalsValue(actual, operand);
      case '$exists':
        return operand === false ? actual === undefined : actual !== undefined;
      case '$gte':
        return typeof actual === 'number' && typeof operand === 'number' && actual >= operand;
      case '$lte':
        return typeof actual === 'number' && typeof operand === 'number' && actual <= operand;
      case '$type':
        if (operand !== 'array') throw new Error(`treeDoubles: unsupported $type ${String(operand)}`);
        return Array.isArray(actual);
      default:
        throw new Error(`treeDoubles: unsupported filter operator ${operator}`);
    }
  });
};

const matches = (doc: Doc, filter: Filter): boolean =>
  Object.entries(filter).every(([path, condition]) => {
    if (path === '_id') return String(doc._id) === String(condition);
    if (path === '$or') {
      if (!Array.isArray(condition)) throw new Error('treeDoubles: $or needs an array');
      return condition.some((clause) => matches(doc, clause as Filter));
    }
    if (path.startsWith('$')) throw new Error(`treeDoubles: unsupported top-level operator ${path}`);
    return matchesField(getPath(doc, path), condition);
  });

const apply = (doc: Doc, update: Update): void => {
  for (const [operator, fields] of Object.entries(update)) {
    for (const [path, value] of Object.entries(fields)) {
      switch (operator) {
        case '$inc': {
          const current = getPath(doc, path);
          setPath(doc, path, (typeof current === 'number' ? current : 0) + (value as number));
          break;
        }
        case '$push': {
          const current = getPath(doc, path);
          // `{ $each: [...], $slice: -n }` appends the items and keeps the LAST n (the only modifiers the code under test uses)
          const modifiers = typeof value === 'object' && value !== null && '$each' in value ? (value as { $each: unknown[]; $slice?: number }) : null;
          let list = [...(Array.isArray(current) ? current : []), ...(modifiers ? clone(modifiers.$each) : [value])];
          if (modifiers?.$slice !== undefined) {
            if (modifiers.$slice >= 0) throw new Error('treeDoubles: only a negative $slice is supported');
            list = list.slice(modifiers.$slice);
          }
          setPath(doc, path, list);
          break;
        }
        case '$addToSet': {
          // Appends unless an equal element is already there (scalars only, like the code under test).
          const current = getPath(doc, path);
          if (current !== undefined && current !== null && !Array.isArray(current)) {
            throw new Error('treeDoubles: $addToSet on a non-array field');
          }
          const list = Array.isArray(current) ? current : [];
          setPath(doc, path, list.some((item) => Object.is(item, value)) ? list : [...list, value]);
          break;
        }
        case '$set':
          setPath(doc, path, clone(value));
          break;
        case '$unset':
          unsetPath(doc, path);
          break;
        default:
          throw new Error(`treeDoubles: unsupported update operator ${operator}`);
      }
    }
  }
};

// ── User store ───────────────────────────────────────────────────────────────────

export type UserStore = ReturnType<typeof createUserStore>;

export function createUserStore() {
  const users = new Map<string, Doc>();
  const ops: StoreOp[] = [];
  /** Only the operations that matched a document and changed it (`ops` also lists attempts that matched nothing). */
  const applied: StoreOp[] = [];
  const hooks: { before?: (op: StoreOp) => Promise<void> | void } = {};
  /** Throw from the next `count` operations whose `op` name (and optional predicate) match. */
  const faults: { op: string; count: number; when?: (op: StoreOp) => boolean }[] = [];

  const enter = async (op: StoreOp): Promise<void> => {
    ops.push(op);
    const fault = faults.find((f) => f.op === op.op && f.count > 0 && (f.when?.(op) ?? true));
    if (fault) {
      fault.count -= 1;
      throw new Error('simulated database failure');
    }
    await hooks.before?.(op);
  };

  const model = {
    findById: (id: string) =>
      query(async () => {
        await enter({ op: 'findById', filter: { _id: id } });
        const doc = users.get(String(id));
        return doc ? clone(doc) : null;
      }),
    findOneAndUpdate: (filter: Filter, update: Update) =>
      query(async () => {
        await enter({ op: 'findOneAndUpdate', filter, update });
        // From here to the return there is NO await: the match and the write are one atomic step.
        for (const doc of users.values()) {
          if (matches(doc, filter)) {
            apply(doc, update);
            applied.push({ op: 'findOneAndUpdate', filter, update });
            return clone(doc);
          }
        }
        return null;
      }),
    updateOne: (filter: Filter, update: Update) =>
      query(async () => {
        await enter({ op: 'updateOne', filter, update });
        for (const doc of users.values()) {
          if (matches(doc, filter)) {
            apply(doc, update);
            applied.push({ op: 'updateOne', filter, update });
            return { matchedCount: 1, modifiedCount: 1 };
          }
        }
        return { matchedCount: 0, modifiedCount: 0 };
      }),
  };

  return {
    model,
    ops,
    applied,
    hooks,
    faults,
    seed(id: string, treeState?: Doc, extra: Doc = {}) {
      users.set(id, { _id: id, tokenVersion: 0, ...(treeState === undefined ? {} : { treeState: clone(treeState) }), ...extra });
    },
    get(id: string): Doc {
      return clone(users.get(id) as Doc);
    },
    tree(id: string): Doc {
      return clone((users.get(id)?.treeState ?? {}) as Doc);
    },
    reset() {
      users.clear();
      ops.length = 0;
      applied.length = 0;
      faults.length = 0;
      hooks.before = undefined;
    },
  };
}

// ── Task store ───────────────────────────────────────────────────────────────────

export type TaskStore = ReturnType<typeof createTaskStore>;

export const taskIdOf = (n: number): string => `507f1f77bcf86cd7994390${String(n).padStart(2, '0')}`;

export function createTaskStore() {
  const tasks = new Map<string, Doc>();
  const ops: StoreOp[] = [];
  const faults: { op: string; count: number }[] = [];
  // Test hooks. `beforeWrite` runs after a findOneAndUpdate's filter was accepted for the call but BEFORE the match and the
  // write, which is exactly where a concurrent request interleaves in production; `delay` lets a seeded scheduler shuffle
  // the order of concurrent requests (every operation yields at least one macrotask tick first).
  const hooks: {
    beforeWrite?: (filter: Filter, update: Doc) => Promise<void> | void;
    delay?: (op: string) => Promise<void> | void;
    /** Awaited at the start of a create, before the unique-key check: a rival request can insert here. */
    beforeCreate?: (data: Doc) => Promise<void> | void;
    /** Awaited at the start of a findOne (a rival request can change the task between this read and a later write). */
    afterFindOne?: (filter: Filter) => Promise<void> | void;
  } = {};
  let nextId = 1;

  const enter = (op: string, filter: Filter): void => {
    ops.push({ op, filter });
    const fault = faults.find((f) => f.op === op && f.count > 0);
    if (fault) {
      fault.count -= 1;
      throw new Error('simulated database failure');
    }
  };
  const owns = (filter: Filter): Doc | null => {
    const { userId, ...rest } = filter;
    // by _id (the common case), or by any other key of the owner's own tasks (the Issue #60 client-key lookup)
    for (const task of tasks.values()) {
      if (task.userId === userId && matches(task, rest)) return task;
    }
    return null;
  };
  // `appliedMutations` is `select: false` on the real model: hidden unless a read asks for it with '+appliedMutations'.
  const visible = (task: Doc, projection?: unknown): Doc => {
    const copy = clone(task);
    if (projection !== '+appliedMutations') delete copy.appliedMutations;
    return copy;
  };

  const model = {
    find: (filter: Filter) => {
      ops.push({ op: 'find', filter });
      const rows = [...tasks.values()].filter((t) => t.userId === filter.userId).map((t) => visible(t));
      const chain: Record<string, unknown> = {};
      chain.sort = () => chain;
      chain.skip = () => chain;
      chain.limit = async () => rows;
      return chain;
    },
    countDocuments: async (filter: Filter) => [...tasks.values()].filter((t) => t.userId === filter.userId).length,
    create: async (data: Doc) => {
      enter('create', { userId: data.userId });
      await hooks.beforeCreate?.(data);
      // the partial unique index (userId, clientKey) of the real model, raised like the driver does
      if (typeof data.clientKey === 'string') {
        const clash = [...tasks.values()].some((t) => t.userId === data.userId && t.clientKey === data.clientKey);
        if (clash) throw Object.assign(new Error('E11000 duplicate key error'), { code: 11000, keyPattern: { userId: 1, clientKey: 1 } });
      }
      const doc = { _id: data._id !== undefined ? String(data._id) : taskIdOf(nextId++), ...data };
      doc._id = String(doc._id);
      tasks.set(String(doc._id), doc);
      return doc;
    },
    // Like Mongoose, the query is awaitable and also offers .lean().
    findOne: (filter: Filter, projection?: unknown) => {
      const run = (async () => {
        enter('findOne', filter);
        await hooks.delay?.('findOne');
        const task = owns(filter);
        const answer = task ? visible(task, projection) : null;
        await hooks.afterFindOne?.(filter);
        return answer;
      })();
      return Object.assign(run, { lean: () => run });
    },
    findOneAndUpdate: async (filter: Filter, update: Doc) => {
      enter('findOneAndUpdate', filter);
      await hooks.delay?.('findOneAndUpdate');
      await hooks.beforeWrite?.(filter, update);
      const task = owns(filter);
      if (!task) return null;
      // Mirror MongoDB: every other condition of the filter (equality, null = missing, $exists/$ne) must hold ATOMICALLY
      // with the write: there is no await between this check and the assignment below.
      const { _id: _ignoredId, userId: _ignoredUser, ...conditions } = filter;
      if (!matches(task, conditions)) return null;
      const { $set, $unset, $push, ...plain } = update as { $set?: Doc; $unset?: Doc; $push?: Doc } & Doc;
      Object.assign(task, plain, $set ?? {});
      for (const key of Object.keys($unset ?? {})) delete task[key];
      if ($push) apply(task, { $push } as Update);
      return visible(task);
    },
    findOneAndDelete: async (filter: Filter) => {
      enter('findOneAndDelete', filter);
      const task = owns(filter);
      if (task) tasks.delete(String(filter._id));
      return task;
    },
  };

  return {
    model,
    ops,
    faults,
    hooks,
    seed(userId: string, over: Doc = {}): Doc {
      const doc: Doc = { _id: taskIdOf(nextId++), userId, title: 'seeded', completed: false, completedAt: null, ...over };
      tasks.set(String(doc._id), doc);
      return doc;
    },
    get: (id: string): Doc | undefined => (tasks.has(id) ? clone(tasks.get(id) as Doc) : undefined),
    /** Changes a stored task directly, as another request that landed in between would (tests only). */
    patch(id: string, fields: Doc): void {
      const stored = tasks.get(id) as Doc;
      for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) delete stored[key]; // undefined removes the field
        else stored[key] = clone(value);
      }
    },
    /** Every stored task, including hidden fields (tests only). */
    all: (): Doc[] => [...tasks.values()].map((t) => clone(t)),
    has: (id: string): boolean => tasks.has(id),
    size: (): number => tasks.size,
    reset() {
      tasks.clear();
      ops.length = 0;
      faults.length = 0;
      nextId = 1;
    },
  };
}

// ── App loader ───────────────────────────────────────────────────────────────────

/** Loads the REAL app with the User and Task models replaced by the stores. Call after `vi.resetModules()`-safe setup. */
export async function loadAppWith(
  users: UserStore,
  tasks: TaskStore,
  jwtSecret: string,
  completions: CompletionStore = createCompletionStore(),
  dayHistory: object = {},
): Promise<Express> {
  vi.resetModules();
  process.env.JWT_SECRET = jwtSecret;
  process.env.CLIENT_ORIGIN = 'http://localhost:5173';
  delete process.env.TRUST_PROXY_HOPS;

  // requireAuth reads `tokenVersion` with findById().select().lean(): answered from the same user store.
  vi.doMock('../../src/models/User.model', () => ({ default: users.model }));
  vi.doMock('../../src/models/Task.model', () => ({ default: tasks.model }));
  installCompletionRecordMock(completions);
  vi.doMock('../../src/models/DayHistory.model', () => ({ default: dayHistory }));
  vi.doMock('web-push', () => ({ default: { setVapidDetails: () => undefined, sendNotification: async () => undefined } }));

  return ((await import('../../src/app.js')) as unknown as { default: Express }).default;
}

export function unmockModels(): void {
  vi.doUnmock('../../src/models/User.model');
  vi.doUnmock('../../src/models/Task.model');
  removeCompletionRecordMock();
  vi.doUnmock('../../src/models/DayHistory.model');
  vi.doUnmock('web-push');
}
