import type { AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAuthStore } from '../store/authStore';
import { resetSyncQueueState, type SyncQueueRecord } from './syncQueue';

// The credential that ACTUALLY goes on the wire when an account's offline queue is replayed.
//
// Checking "is the owner still signed in?" before calling the service is not enough: the service builds
// the request a moment later and (for ordinary callers) reads whichever token is current THEN, so an
// account switch landing in that gap would send A's queued mutation as B. Here the real task service and
// the real API client (with its real request interceptor) run against a recording adapter, so every
// assertion is about what a request really carried — or that it was never sent.

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

import { apiClient } from '../services/api';
import { taskService } from '../services/taskService';
import { processSyncQueue } from './queueProcessor';

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };

const TOKEN_A = 'token-user-a';
const TOKEN_B = 'token-user-b';

const signIn = (user: typeof USER_A, token = `token-${user.id}`) => useAuthStore.setState({ token, user });
const signOut = () => useAuthStore.setState({ token: null, user: null });

const keyOf = (userId: string) => `sync_queue:${userId}`;
const seed = (userId: string, entries: SyncQueueRecord[]) => db.store.set(keyOf(userId), structuredClone(entries));
const idsOf = (userId: string) => ((db.store.get(keyOf(userId)) ?? []) as SyncQueueRecord[]).map((e) => e.id);

const update = (id: string, taskId: string): SyncQueueRecord => ({
  id,
  type: 'update',
  taskId,
  payload: { title: `title-${id}` },
  createdAt: 1,
});

// One entry of each kind, with the request it turns into and the UI callback it feeds.
const KINDS = [
  {
    kind: 'create',
    entry: { id: 'k1', type: 'create', taskId: 'local-1', payload: { title: 'new' }, createdAt: 1 } as SyncQueueRecord,
    method: 'POST',
    url: '/api/tasks',
    callback: 'onTaskCreated',
  },
  {
    kind: 'update',
    entry: update('k1', 'srv-1'),
    method: 'PUT',
    url: '/api/tasks/srv-1',
    callback: 'onTaskUpdated',
  },
  {
    kind: 'delete',
    entry: { id: 'k1', type: 'delete', taskId: 'srv-1', createdAt: 1 } as SyncQueueRecord,
    method: 'DELETE',
    url: '/api/tasks/srv-1',
    callback: 'onTaskDeleted',
  },
] as const;

const callbacks = () => ({
  onTaskCreated: vi.fn(),
  onTaskUpdated: vi.fn(),
  onTaskDeleted: vi.fn(),
});

// Every request that actually reached the network layer, with the credential it carried.
type Sent = { method: string; url: string; authorization: string | null };
const sent: Sent[] = [];
// Runs inside the adapter, i.e. while a request is genuinely in flight.
const inFlight = { hook: null as null | (() => void) };

const originalAdapter = apiClient.defaults.adapter;

beforeEach(() => {
  db.store.clear();
  sent.length = 0;
  inFlight.hook = null;
  resetSyncQueueState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  apiClient.defaults.adapter = async (config: InternalAxiosRequestConfig): Promise<AxiosResponse> => {
    const header = config.headers.get('Authorization');
    sent.push({
      method: String(config.method).toUpperCase(),
      url: String(config.url),
      authorization: typeof header === 'string' ? header : null,
    });
    inFlight.hook?.();
    const id = String(config.url).split('/').pop() ?? 'srv';
    return { data: { task: { _id: id } }, status: 200, statusText: 'OK', headers: {}, config };
  };
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
});

describe('which credential a queued request carries', () => {
  it('A’s queue goes out with A’s token, and B’s queue with B’s token', async () => {
    seed(USER_A.id, [update('a1', 'srv-a1')]);
    seed(USER_B.id, [update('b1', 'srv-b1')]);

    signIn(USER_A);
    await processSyncQueue(callbacks());
    signIn(USER_B);
    await processSyncQueue(callbacks());

    expect(sent).toEqual([
      { method: 'PUT', url: '/api/tasks/srv-a1', authorization: `Bearer ${TOKEN_A}` },
      { method: 'PUT', url: '/api/tasks/srv-b1', authorization: `Bearer ${TOKEN_B}` },
    ]);
    expect(idsOf(USER_A.id)).toEqual([]);
    expect(idsOf(USER_B.id)).toEqual([]);
  });

  it('an ordinary request (no bound session) still just uses the current token', async () => {
    signIn(USER_B);
    await taskService.updateTask('srv-1', { completed: true });

    expect(sent).toEqual([{ method: 'PUT', url: '/api/tasks/srv-1', authorization: `Bearer ${TOKEN_B}` }]);
  });
});

describe('the account switches between the ownership check and the request', () => {
  // A test request interceptor registered AFTER the production one runs BEFORE it (axios runs request
  // interceptors last-registered-first). So this switch lands exactly where the old code was exposed:
  // after processSyncQueue has decided "A is still signed in" and called the service, but before the
  // request's credential is read.
  let eject: number | null = null;

  const switchBeforeCredentialIsRead = (to: () => void) => {
    let done = false;
    eject = apiClient.interceptors.request.use((config) => {
      if (!done) {
        done = true;
        to();
      }
      return config;
    });
  };

  afterEach(() => {
    if (eject !== null) apiClient.interceptors.request.eject(eject);
    eject = null;
  });

  it.each(KINDS)(
    'A → B before the $kind request is built: nothing is sent, and B’s credential is never used',
    async ({ entry, callback }) => {
      seed(USER_A.id, [entry, update('k2', 'srv-2')]);
      seed(USER_B.id, [update('b1', 'srv-b1')]);
      signIn(USER_A);
      switchBeforeCredentialIsRead(() => signIn(USER_B));
      const cb = callbacks();

      const result = await processSyncQueue(cb);

      expect(sent).toEqual([]); // not sent at all — in particular not as B
      expect(sent.some((r) => r.authorization === `Bearer ${TOKEN_B}`)).toBe(false);
      expect(result).toEqual({ processed: 0, failed: 2, remaining: 2 });
      expect(idsOf(USER_A.id)).toEqual(['k1', 'k2']); // all kept for A
      expect(idsOf(USER_B.id)).toEqual(['b1']); // B's queue untouched
      expect(cb[callback]).not.toHaveBeenCalled();
    },
  );

  it('…and once A is back, the kept entries go out with A’s token', async () => {
    seed(USER_A.id, [update('a1', 'srv-a1'), update('a2', 'srv-a2')]);
    signIn(USER_A);
    switchBeforeCredentialIsRead(() => signIn(USER_B));
    await processSyncQueue(callbacks());
    expect(sent).toEqual([]);

    signIn(USER_A);
    const result = await processSyncQueue(callbacks());

    expect(result).toEqual({ processed: 2, failed: 0, remaining: 0 });
    expect(sent.map((r) => r.authorization)).toEqual([`Bearer ${TOKEN_A}`, `Bearer ${TOKEN_A}`]);
  });

  it('the same account re-signing in (a different token) before the request: refused, not sent with either', async () => {
    seed(USER_A.id, [update('a1', 'srv-a1')]);
    signIn(USER_A);
    switchBeforeCredentialIsRead(() => signIn(USER_A, 'token-user-a-second-login'));

    const result = await processSyncQueue(callbacks());

    expect(sent).toEqual([]);
    expect(result.remaining).toBe(1);
    expect(idsOf(USER_A.id)).toEqual(['a1']);
  });

  it('the signed-in account record changes under an unchanged token: refused too (both halves are checked)', async () => {
    seed(USER_A.id, [update('a1', 'srv-a1')]);
    signIn(USER_A);
    switchBeforeCredentialIsRead(() => useAuthStore.setState({ user: USER_B })); // token still A's

    const result = await processSyncQueue(callbacks());

    expect(sent).toEqual([]);
    expect(result.remaining).toBe(1);
    expect(idsOf(USER_A.id)).toEqual(['a1']);
  });

  it('signing out before the request: refused, not sent without credentials', async () => {
    seed(USER_A.id, [update('a1', 'srv-a1')]);
    signIn(USER_A);
    switchBeforeCredentialIsRead(() => signOut());

    const result = await processSyncQueue(callbacks());

    expect(sent).toEqual([]);
    expect(result.remaining).toBe(1);
    expect(idsOf(USER_A.id)).toEqual(['a1']);
  });
});

describe('the account switches while a request is in flight', () => {
  it.each(KINDS)(
    'a $kind that already left stays A’s; nothing further is sent; B’s screen is not fed A’s result',
    async ({ entry, method, url, callback }) => {
      seed(USER_A.id, [entry, update('k2', 'srv-2'), update('k3', 'srv-3')]);
      seed(USER_B.id, [update('b1', 'srv-b1')]);
      signIn(USER_A);
      inFlight.hook = () => {
        inFlight.hook = null;
        signIn(USER_B);
      };
      const cb = callbacks();

      const result = await processSyncQueue(cb);

      expect(sent).toEqual([{ method, url, authorization: `Bearer ${TOKEN_A}` }]);
      expect(result).toEqual({ processed: 1, failed: 2, remaining: 2 });
      expect(idsOf(USER_A.id)).toEqual(['k2', 'k3']);
      expect(idsOf(USER_B.id)).toEqual(['b1']);
      expect(cb[callback]).not.toHaveBeenCalled(); // the result belongs to A, who is no longer on screen
    },
  );

  it.each(KINDS)('control: with no switch, a $kind feeds its result back to the screen', async ({ entry, callback }) => {
    seed(USER_A.id, [entry]);
    signIn(USER_A);
    const cb = callbacks();

    await processSyncQueue(cb);

    expect(cb[callback]).toHaveBeenCalledTimes(1);
  });
});
