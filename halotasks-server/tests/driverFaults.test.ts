// Runs without MongoDB. Verifies the fault-injection helper itself (tests/helpers/driverFaults.ts), because the
// real-MongoDB suites rely on it: nothing fails unless planned, a fault hits exactly the command it names, plans cannot
// leak across reset(), and restore() puts the original methods back.
import { describe, expect, it } from 'vitest';
import { SIMULATED_FAILURE_MESSAGE, installDriverFaults, isAwardWrite, isDerivedWrite } from './helpers/driverFaults';

const derivedUpdate = { $set: { 'treeState.streakDays': 1, 'treeState.lastActiveDate': 'x' } };
const awardUpdate = { $inc: { 'treeState.xp': 10 }, $push: { 'treeState.awardedTaskIds': 'a' } };

const makeCollections = () => {
  const calls: string[] = [];
  const method = (label: string) =>
    function (this: unknown, ..._args: unknown[]) {
      calls.push(label);
      return Promise.resolve(label);
    };
  // Methods live on the prototype, like Mongoose's NativeCollection, so restore() must delete the own override.
  const proto = {
    findOneAndUpdate: method('users.findOneAndUpdate'),
    findOne: method('users.findOne'),
    findOneAndDelete: method('users.findOneAndDelete'),
  };
  const users = Object.create(proto) as Record<string, unknown>;
  const tasks = Object.create({ ...proto, findOneAndUpdate: method('tasks.findOneAndUpdate'), findOneAndDelete: method('tasks.findOneAndDelete') }) as Record<string, unknown>;
  return { users, tasks, calls, proto };
};

describe('driverFaults helper', () => {
  it('recognises the derived write and the award write by their update documents, and nothing else', () => {
    expect(isDerivedWrite([{}, derivedUpdate])).toBe(true);
    expect(isAwardWrite([{}, derivedUpdate])).toBe(false);
    expect(isAwardWrite([{}, awardUpdate])).toBe(true);
    expect(isDerivedWrite([{}, awardUpdate])).toBe(false);
    expect(isDerivedWrite([{}, { $set: { title: 't' } }])).toBe(false);
    expect(isDerivedWrite([{}])).toBe(false);
  });

  it('passes everything through when nothing is planned', async () => {
    const { users, tasks, calls } = makeCollections();
    const faults = installDriverFaults({ users, tasks });
    await expect((users.findOneAndUpdate as (...a: unknown[]) => unknown)({}, derivedUpdate)).resolves.toBe('users.findOneAndUpdate');
    await expect((users.findOne as (...a: unknown[]) => unknown)({})).resolves.toBe('users.findOne');
    await expect((tasks.findOneAndUpdate as (...a: unknown[]) => unknown)({}, {})).resolves.toBe('tasks.findOneAndUpdate');
    expect(calls).toHaveLength(3);
    expect(faults.pending()).toBe(0);
    expect(faults.trace()).toEqual(['users.derived', 'users.read', 'tasks.update']);
    faults.restore();
  });

  it('fails only the planned kind, only the planned number of times, and never touches the database for it', async () => {
    const { users, tasks, calls } = makeCollections();
    const faults = installDriverFaults({ users, tasks });
    const update = users.findOneAndUpdate as (...a: unknown[]) => Promise<unknown>;

    faults.failNext('derived', 2);
    await expect(update({}, awardUpdate)).resolves.toBe('users.findOneAndUpdate'); // an award is not a derived write
    await expect(update({}, derivedUpdate)).rejects.toThrow(SIMULATED_FAILURE_MESSAGE);
    await expect(update({}, derivedUpdate)).rejects.toThrow(SIMULATED_FAILURE_MESSAGE);
    await expect(update({}, derivedUpdate)).resolves.toBe('users.findOneAndUpdate'); // plan exhausted
    expect(faults.injected('derived')).toBe(2);
    expect(faults.pending()).toBe(0);
    expect(calls).toHaveLength(2); // the two failed commands never reached the collection
    expect(faults.trace()).toEqual(['users.award', 'users.derived!', 'users.derived!', 'users.derived']);
    faults.restore();
  });

  it('only fails a read as the read-back once a derived failure has fired, and only the first one', async () => {
    const { users, tasks } = makeCollections();
    const faults = installDriverFaults({ users, tasks });
    const read = users.findOne as (...a: unknown[]) => Promise<unknown>;
    const update = users.findOneAndUpdate as (...a: unknown[]) => Promise<unknown>;

    faults.failNext('readback');
    await expect(read({})).resolves.toBe('users.findOne'); // planned, but no derived failure has fired: untouched
    expect(faults.pending()).toBe(1);

    faults.failNext('derived');
    await expect(update({}, derivedUpdate)).rejects.toThrow(SIMULATED_FAILURE_MESSAGE);
    await expect(read({})).rejects.toThrow(SIMULATED_FAILURE_MESSAGE); // the first read after it
    await expect(read({})).resolves.toBe('users.findOne'); // later reads are untouched
    expect(faults.trace()).toEqual(['users.read', 'users.derived!', 'users.read!', 'users.read']);
    expect(faults.pending()).toBe(0);
    faults.restore();
  });

  it('reset() drops plans, counters and the trace, so a fault cannot leak into the next test', async () => {
    const { users, tasks } = makeCollections();
    const faults = installDriverFaults({ users, tasks });
    faults.failNext('taskUpdate');
    faults.failNext('taskDelete', 3);
    expect(faults.pending()).toBe(4);
    faults.reset();
    expect(faults.pending()).toBe(0);
    expect(faults.trace()).toEqual([]);
    await expect((tasks.findOneAndUpdate as (...a: unknown[]) => unknown)({}, {})).resolves.toBe('tasks.findOneAndUpdate');
    await expect((tasks.findOneAndDelete as (...a: unknown[]) => unknown)({})).resolves.toBe('tasks.findOneAndDelete');
    expect(faults.injected('taskUpdate')).toBe(0);
    faults.restore();
  });

  it('restore() removes the wrappers (prototype methods are visible again) and is idempotent', async () => {
    const { users, tasks, calls } = makeCollections();
    const before = users.findOneAndUpdate;
    const faults = installDriverFaults({ users, tasks });
    expect(users.findOneAndUpdate).not.toBe(before);
    expect(Object.prototype.hasOwnProperty.call(users, 'findOneAndUpdate')).toBe(true);

    faults.failNext('derived');
    faults.restore();
    faults.restore();
    expect(Object.prototype.hasOwnProperty.call(users, 'findOneAndUpdate')).toBe(false);
    expect(users.findOneAndUpdate).toBe(before);
    await expect((users.findOneAndUpdate as (...a: unknown[]) => unknown)({}, derivedUpdate)).resolves.toBe('users.findOneAndUpdate');
    expect(calls).toEqual(['users.findOneAndUpdate']);
  });
});
