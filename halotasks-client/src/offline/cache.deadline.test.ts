import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeTask } from '../test/taskFactory';

// Local cache persistence and reload for the time fields (Issues #9, #10). IndexedDB itself is replaced by a Map that
// stores structured clones, which is exactly what IndexedDB does to a value, so this proves the fields survive
// serialization and a reload (a fresh read). The cache is one generic key-value store (see offline/db.ts), so no
// schema migration is involved. It does not exercise a real browser IndexedDB.

const db = vi.hoisted(() => ({ store: new Map<string, unknown>() }));

vi.mock('./db', () => ({
  offlineDb: {
    get: async (key: string) => (db.store.has(key) ? structuredClone(db.store.get(key)) : null),
    set: async (key: string, value: unknown) => {
      db.store.set(key, structuredClone(value));
    },
    remove: async (key: string) => {
      db.store.delete(key);
    },
  },
}));

import { getCachedTasks, setCachedTasks } from './cache';

beforeEach(() => db.store.clear());

describe('cached tasks keep their time fields', () => {
  it('round-trips a task with a due time and a start time, byte for byte', async () => {
    const timed = makeTask({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', startTime: '2026-10-20T09:30:00.000Z' });

    await setCachedTasks([timed]);
    const reloaded = await getCachedTasks();

    expect(reloaded).toEqual([timed]);
    expect(reloaded[0].dueTime).toBe('17:30');
    expect(reloaded[0].startTime).toBe('2026-10-20T09:30:00.000Z');
  });

  it('round-trips each combination: neither, start only, due only, due plus time', async () => {
    const tasks = [
      makeTask({ _id: 'neither' }),
      makeTask({ _id: 'start-only', startTime: '2026-10-20T09:30:00.000Z' }),
      makeTask({ _id: 'due-only', dueDate: '2026-10-20T00:00:00.000Z' }),
      makeTask({ _id: 'due-time', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '00:00' }),
    ];

    await setCachedTasks(tasks);

    expect(await getCachedTasks()).toEqual(tasks);
  });

  it('a task cached before these fields existed reloads without them, and is not given any', async () => {
    const legacy = { ...makeTask({ dueDate: '2026-04-21T00:00:00.000Z' }) };
    await setCachedTasks([legacy]);

    const [reloaded] = await getCachedTasks();

    expect(reloaded).toEqual(legacy);
    expect(reloaded).not.toHaveProperty('dueTime');
    expect(reloaded).not.toHaveProperty('startTime');
  });

  it('an offline edit that clears a time is what reloads (a cleared field stays cleared)', async () => {
    const before = makeTask({ dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30', startTime: '2026-10-20T09:30:00.000Z' });
    await setCachedTasks([before]);

    const [cached] = await getCachedTasks();
    await setCachedTasks([{ ...cached, dueTime: undefined, startTime: undefined }]);
    const [after] = await getCachedTasks();

    expect(after.dueTime).toBeUndefined();
    expect(after.startTime).toBeUndefined();
    expect(after.dueDate).toBe('2026-10-20T00:00:00.000Z');
  });
});
