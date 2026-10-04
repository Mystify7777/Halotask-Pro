import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/authStore';

// Storage-level isolation of the offline action queue. Every record lives under `sync_queue:<userId>`;
// there is no way to read or write a queue without naming whose it is.

const db = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  failRemoveOnce: false,
  reads: [] as string[],
}));

vi.mock('./db', () => ({
  offlineDb: {
    get: async (key: string) => {
      db.reads.push(key);
      return db.store.has(key) ? structuredClone(db.store.get(key)) : null;
    },
    set: async (key: string, value: unknown) => {
      db.store.set(key, structuredClone(value));
    },
    remove: async (key: string) => {
      if (db.failRemoveOnce) {
        db.failRemoveOnce = false;
        throw new Error('storage unavailable');
      }
      db.store.delete(key);
    },
  },
}));

import {
  clearSyncQueue,
  enqueueSyncAction,
  getSyncQueue,
  resetSyncQueueState,
  setSyncQueue,
  type SyncQueueRecord,
} from './syncQueue';

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };

const signIn = (user: typeof USER_A) => useAuthStore.setState({ token: `token-${user.id}`, user });
const signOut = () => useAuthStore.setState({ token: null, user: null });

const keyOf = (userId: string) => `sync_queue:${userId}`;
const stored = (userId: string) => (db.store.get(keyOf(userId)) ?? []) as SyncQueueRecord[];

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db.store.clear();
  db.failRemoveOnce = false;
  db.reads.length = 0;
  resetSyncQueueState();
  signIn(USER_A);
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('enqueueSyncAction', () => {
  it('stores each account’s actions under that account only', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'A task' } });
    signIn(USER_B);
    await enqueueSyncAction({ type: 'create', taskId: 'local-2', payload: { title: 'B task' } });

    expect(stored(USER_A.id).map((e) => e.taskId)).toEqual(['local-1']);
    expect(stored(USER_B.id).map((e) => e.taskId)).toEqual(['local-2']);
    expect((await getSyncQueue()).map((e) => e.taskId)).toEqual(['local-2']); // current account only
    signIn(USER_A);
    expect((await getSyncQueue()).map((e) => e.taskId)).toEqual(['local-1']);
  });

  it('binds the action to the account that made it, even if another signs in before the write', async () => {
    const pending = enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'A task' } });
    signIn(USER_B); // switches before the queued write has run
    await pending;

    expect(stored(USER_A.id).map((e) => e.taskId)).toEqual(['local-1']);
    expect(stored(USER_B.id)).toEqual([]);
  });

  it('refuses to queue anything when nobody is signed in, and writes nothing', async () => {
    signOut();

    await expect(enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: {} })).rejects.toThrow(
      /signed-in account/,
    );
    expect(db.store.size).toBe(0);
  });

  it('coalesces within one account without touching another account’s entries for the same task id', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: { title: 'old' } });
    signIn(USER_B);
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { title: 'B edit' } });
    signIn(USER_A);
    await enqueueSyncAction({ type: 'update', taskId: 'local-1', payload: { title: 'new' } });

    // A: the update folded into A's own create. B: kept as B's own update (B has no such create).
    expect(stored(USER_A.id)).toHaveLength(1);
    expect(stored(USER_A.id)[0]).toMatchObject({ type: 'create', payload: { title: 'new' } });
    expect(stored(USER_B.id)).toHaveLength(1);
    expect(stored(USER_B.id)[0]).toMatchObject({ type: 'update', payload: { title: 'B edit' } });
  });

  it('a delete cancels only the same account’s pending create', async () => {
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: {} });
    signIn(USER_B);
    await enqueueSyncAction({ type: 'create', taskId: 'local-1', payload: {} });
    signIn(USER_A);
    await enqueueSyncAction({ type: 'delete', taskId: 'local-1' });

    expect(stored(USER_A.id)).toEqual([]);
    expect(stored(USER_B.id)).toHaveLength(1);
  });
});

describe('getSyncQueue / setSyncQueue / clearSyncQueue', () => {
  it('reads nothing for nobody, without touching storage for a queue', async () => {
    signOut();
    expect(await getSyncQueue()).toEqual([]);
    expect(await getSyncQueue(null)).toEqual([]);
    expect(db.reads.filter((k) => k.startsWith('sync_queue:'))).toEqual([]);
  });

  it('an explicit owner wins over the signed-in account', async () => {
    await setSyncQueue([{ id: 'x', type: 'delete', taskId: 'srv-1', createdAt: 1 }], USER_B.id);

    expect(stored(USER_B.id)).toHaveLength(1);
    expect(stored(USER_A.id)).toEqual([]);
    expect(await getSyncQueue(USER_B.id)).toHaveLength(1);
    expect(await getSyncQueue()).toEqual([]); // A is signed in
  });

  it('refuses to write a queue with no owner', async () => {
    signOut();
    await expect(setSyncQueue([])).rejects.toThrow(/owning account/);
  });

  it('clears only the named account’s queue', async () => {
    await setSyncQueue([{ id: 'a', type: 'delete', taskId: 'srv-1', createdAt: 1 }], USER_A.id);
    await setSyncQueue([{ id: 'b', type: 'delete', taskId: 'srv-2', createdAt: 1 }], USER_B.id);

    await clearSyncQueue(USER_A.id);

    expect(stored(USER_A.id)).toEqual([]);
    expect(stored(USER_B.id)).toHaveLength(1);
  });
});

describe('the legacy unscoped queue', () => {
  const legacy = [
    { id: 'old-1', type: 'update', taskId: 'srv-1', payload: { title: 'who made me?' }, createdAt: 1 },
    { id: 'old-2', type: 'delete', taskId: 'srv-2', createdAt: 2 },
  ];

  it('is never handed to whoever signs in: removed once, to nobody', async () => {
    db.store.set('sync_queue', structuredClone(legacy));

    expect(await getSyncQueue()).toEqual([]); // A
    signIn(USER_B);
    expect(await getSyncQueue()).toEqual([]); // B

    expect(db.store.has('sync_queue')).toBe(false);
    expect(stored(USER_A.id)).toEqual([]);
    expect(stored(USER_B.id)).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toContain('2 queued action(s)');
  });

  it('is only looked at once', async () => {
    await getSyncQueue();
    await getSyncQueue();
    await getSyncQueue();

    expect(db.reads.filter((k) => k === 'sync_queue')).toHaveLength(1);
  });

  it('says nothing when there was nothing to discard', async () => {
    await getSyncQueue();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('retries the removal later if storage failed the first time', async () => {
    db.store.set('sync_queue', structuredClone(legacy));
    db.failRemoveOnce = true;

    expect(await getSyncQueue()).toEqual([]);
    expect(db.store.has('sync_queue')).toBe(true); // still there, but never read as anyone's queue

    expect(await getSyncQueue()).toEqual([]);
    expect(db.store.has('sync_queue')).toBe(false);
  });

  it('does not collide with an account whose id looks like the legacy key', async () => {
    await setSyncQueue([{ id: 'z', type: 'delete', taskId: 'srv-1', createdAt: 1 }], 'sync_queue');

    expect(db.store.has('sync_queue:sync_queue')).toBe(true);
    expect(db.store.has('sync_queue')).toBe(false);
  });
});
