// Targeted failure injection for tests that run against a REAL MongoDB.
//
// tests/helpers/treeDoubles.ts replaces the models with in-memory stores. The real-MongoDB suites must not do
// that: persistence, atomicity and concurrency are the point. So this helper changes nothing about how the
// database behaves. It wraps a few methods of the native collections (the same layer tests/treeAward.mongoose.test.ts
// intercepts) and, ONLY when a failure has been planned for that exact kind of command, rejects it the way a lost
// connection would. Every other call, and every call when nothing is planned, goes straight to the real database.
//
// The kinds name the commands the Growth Tree code issues (utils/treeAward.ts, controllers/task.controller.ts):
//   derived   — step 2 of an award: the pinned $set of streakDays/lastActiveDate/... (a findOneAndUpdate on users).
//               Failing it is how "the award is recorded but its derived state is not persisted" is produced.
//   award     — step 1 of an award: the atomic $inc/$push/$addToSet (a findOneAndUpdate on users).
//   readback  — the first read of a user AFTER a `derived` failure fired (what POST does to build its response).
//   taskUpdate— the task write of PUT /api/tasks/:id (a findOneAndUpdate on tasks).
//   taskDelete— the cleanup of a just-created task when POST's award failed (a findOneAndDelete on tasks).
//
// `injected(kind)` reports how many failures actually fired, so a test can prove it exercised the path it names
// instead of passing vacuously. `trace()` is the ordered list of every wrapped command the database received
// ('users.derived', 'users.award', 'users.update', 'users.read', 'tasks.update', 'tasks.delete'; a trailing '!' marks
// one that was failed on purpose), so a test can prove WHICH of the wrapped commands a fault hit (e.g. that the failed
// read was the next wrapped command after the failed derived write). It lists only wrapped commands: it cannot show that
// no other driver command ran in between.
//
// Lifecycle: nothing is ever failed unless a test planned it with failNext(); reset() drops every plan, every counter
// (including the fired-derived condition that arms the read-back fault) and the trace (call it before and after each
// test); restore() puts the original methods back and is idempotent.

export type FaultKind = 'derived' | 'award' | 'readback' | 'taskUpdate' | 'taskDelete';

const KINDS: FaultKind[] = ['derived', 'award', 'readback', 'taskUpdate', 'taskDelete'];

export const SIMULATED_FAILURE_MESSAGE = 'simulated database failure';

type Method = (...args: unknown[]) => unknown;
type Update = { $set?: Record<string, unknown>; $inc?: Record<string, unknown> };

const updateOf = (args: unknown[]): Update => (typeof args[1] === 'object' && args[1] !== null ? (args[1] as Update) : {});

/** Step 2 of an award writes the streak; no other command the code issues does. */
export const isDerivedWrite = (args: unknown[]): boolean => updateOf(args).$set?.['treeState.streakDays'] !== undefined;

/** Step 1 of an award is the only command that increments xp. */
export const isAwardWrite = (args: unknown[]): boolean => updateOf(args).$inc?.['treeState.xp'] !== undefined;

const zero = (): Record<FaultKind, number> => ({ derived: 0, award: 0, readback: 0, taskUpdate: 0, taskDelete: 0 });

export function installDriverFaults(collections: { users: object; tasks: object }) {
  const plan = zero();
  const fired = zero();
  const undo: Array<() => void> = [];
  let events: string[] = [];

  const take = (kind: FaultKind): boolean => {
    if (plan[kind] <= 0) return false;
    plan[kind] -= 1;
    fired[kind] += 1;
    return true;
  };

  const wrap = (target: object, name: string, label: (args: unknown[]) => string, shouldFail: (args: unknown[]) => boolean) => {
    const holder = target as Record<string, Method>;
    const hadOwn = Object.prototype.hasOwnProperty.call(holder, name);
    const original = holder[name];
    holder[name] = function (this: unknown, ...args: unknown[]) {
      const command = label(args);
      if (shouldFail(args)) {
        events.push(`${command}!`);
        return Promise.reject(new Error(SIMULATED_FAILURE_MESSAGE));
      }
      events.push(command);
      return original.apply(this, args);
    };
    undo.push(() => {
      if (hadOwn) holder[name] = original;
      else delete holder[name];
    });
  };

  wrap(
    collections.users,
    'findOneAndUpdate',
    (args) => (isDerivedWrite(args) ? 'users.derived' : isAwardWrite(args) ? 'users.award' : 'users.update'),
    (args) => (isDerivedWrite(args) && take('derived')) || (isAwardWrite(args) && take('award')),
  );
  // Only a read that follows an injected derived failure can be failed as the read-back; nothing else is ever failed
  // here. (Every request also reads the user once for authentication, before any fault in that request can fire.)
  wrap(collections.users, 'findOne', () => 'users.read', () => fired.derived > 0 && take('readback'));
  wrap(collections.tasks, 'findOneAndUpdate', () => 'tasks.update', () => take('taskUpdate'));
  wrap(collections.tasks, 'findOneAndDelete', () => 'tasks.delete', () => take('taskDelete'));

  return {
    /** Fail the next `count` commands of this kind (they are counted in the order the database receives them). */
    failNext(kind: FaultKind, count = 1): void {
      plan[kind] += count;
    },
    /** How many failures of this kind have actually fired. */
    injected(kind: FaultKind): number {
      return fired[kind];
    },
    /** Failures planned but not yet fired. A test that ends with any left over planned a path it never took. */
    pending(): number {
      return KINDS.reduce((sum, kind) => sum + plan[kind], 0);
    },
    /** Every wrapped command received since the last reset, in order; '!' marks an injected failure. */
    trace(): readonly string[] {
      return [...events];
    },
    /** Forget every plan, counter and trace entry (the wrappers stay installed, and pass everything through). */
    reset(): void {
      for (const kind of KINDS) {
        plan[kind] = 0;
        fired[kind] = 0;
      }
      events = [];
    },
    /** Put the original collection methods back (idempotent). */
    restore(): void {
      while (undo.length > 0) undo.pop()?.();
    },
  };
}
