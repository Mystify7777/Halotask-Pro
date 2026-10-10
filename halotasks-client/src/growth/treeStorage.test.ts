import { beforeEach, describe, expect, it, vi } from 'vitest';

// One shared in-memory "browser storage", exactly like the real IndexedDB
// would be shared by every account that logs in on the same browser.
const idb = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../offline/db', () => ({
  offlineDb: {
    get: vi.fn(async (key: string) => (idb.has(key) ? idb.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      idb.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      idb.delete(key);
    }),
  },
}));

vi.mock('../services/treeService', () => ({
  treeService: { getTree: vi.fn() },
}));

import { useAuthStore } from '../store/authStore';
import { treeService } from '../services/treeService';
import {
  applyServerGrowth,
  clearTreeState,
  getTreeState,
  initTreeStorage,
  resetCache,
  TreeIdentityError,
} from './treeStorage';
import type { GrowthResult, TreeStateJSON } from './treeTypes';

// ── Helpers ────────────────────────────────────────────────────────────────

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };

const login = (user: typeof USER_A) => useAuthStore.getState().setAuth({ token: `token-${user.id}`, user });
const logout = () => useAuthStore.getState().clearAuth();
const currentUserId = () => useAuthStore.getState().user?.id ?? null;

const json = (xp: number, awardedTaskIds: string[] = []): TreeStateJSON => ({
  xp,
  leaves: Math.floor(xp / 20),
  streakDays: 0,
  lastActiveDate: null,
  health: 'healthy',
  stage: 'seed',
  lastCalculatedAt: new Date().toISOString(),
  awardedTaskIds,
});

// What the server returns inside a task response after awarding `taskId` (the tree it now holds).
const growth = (taskId: string, xp: number, awarded = true, reason?: GrowthResult['reason']): GrowthResult => {
  const { awardedTaskIds: _ledger, ...summary } = json(xp);
  void _ledger;
  return { taskId, awarded, xpGained: awarded ? 10 : 0, ...(reason ? { reason } : {}), treeState: summary };
};

// Fake server: records are keyed by whichever user's token is active when the
// request is made — mirroring how the real API derives the user from the JWT.
const serverRecords = new Map<string, TreeStateJSON>();
let serverOffline = false;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const scopedKeys = () => [...idb.keys()].filter((k) => k.startsWith('growth_tree:'));

beforeEach(() => {
  idb.clear();
  localStorage.clear();
  serverRecords.clear();
  serverOffline = false;
  resetCache();
  logout();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  vi.mocked(treeService.getTree).mockReset().mockImplementation(async () => {
    const userId = currentUserId();
    if (serverOffline || !userId) throw new Error('network');
    return serverRecords.get(userId) ?? json(0);
  });
});

// ── Single-user behaviour is preserved ─────────────────────────────────────

describe('single user', () => {
  it('adopts the server tree on init and keeps a copy under a user-scoped key', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(30, ['t1']));

    const initial = await initTreeStorage();
    await flush();

    expect(initial.xp).toBe(30);
    expect([...initial.awardedTaskIds]).toEqual(['t1']);
    expect(getTreeState().xp).toBe(30);
    expect(scopedKeys()).toEqual(['growth_tree:user-a']);
    expect((idb.get('growth_tree:user-a') as TreeStateJSON).xp).toBe(30);
  });

  it('falls back to the stored copy only when the server cannot be reached (display only)', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(40, ['t1', 't2']));
    await initTreeStorage();
    await flush();

    serverOffline = true;
    resetCache(); // simulates a fresh page load
    const restored = await initTreeStorage();

    expect(restored.xp).toBe(40);
    expect([...restored.awardedTaskIds].sort()).toEqual(['t1', 't2']);
  });

  it('does NOT do a "higher XP wins" merge any more: the server tree replaces a higher local copy', async () => {
    login(USER_A);
    idb.set('growth_tree:user-a', json(500, ['local-forged']));
    serverRecords.set('user-a', json(20, ['remote']));

    const state = await initTreeStorage();
    await flush();

    expect(state.xp).toBe(20);
    expect([...state.awardedTaskIds]).toEqual(['remote']);
    expect(state.awardedTaskIds.has('local-forged')).toBe(false);
    expect((idb.get('growth_tree:user-a') as TreeStateJSON).xp).toBe(20); // the local copy is overwritten by the server's
  });
});

describe('applyServerGrowth: the server response becomes the tree', () => {
  it('adopts every server-computed field and records the awarded id', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(10, ['t1']));
    await initTreeStorage();

    const incoming = growth('t2', 20);
    incoming.treeState = { ...incoming.treeState, streakDays: 3, stage: 'sprout', health: 'healthy', lastActiveDate: '2026-10-06' };
    const next = applyServerGrowth(incoming);
    await flush();

    expect(next).toMatchObject({ xp: 20, streakDays: 3, stage: 'sprout', lastActiveDate: '2026-10-06' });
    expect([...next.awardedTaskIds].sort()).toEqual(['t1', 't2']);
    expect(getTreeState().xp).toBe(20);
    expect((idb.get('growth_tree:user-a') as TreeStateJSON).xp).toBe(20);
  });

  it('applies a refused award too (already_awarded) so the cache converges on the server', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(10, []));
    await initTreeStorage();

    const next = applyServerGrowth(growth('t9', 50, false, 'already_awarded'));

    expect(next.xp).toBe(50);
    expect(next.awardedTaskIds.has('t9')).toBe(true);
  });

  it('does not record an id for a refusal that is not an award (ledger_full)', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(10, []));
    await initTreeStorage();
    const next = applyServerGrowth(growth('t9', 10, false, 'ledger_full'));
    expect(next.awardedTaskIds.has('t9')).toBe(false);
  });

  it('ignores a stale response (bulk requests can finish out of order): XP never goes backwards', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(10));
    await initTreeStorage();

    applyServerGrowth(growth('t3', 30));
    const stale = applyServerGrowth(growth('t2', 20));

    expect(stale.xp).toBe(30);
    expect(getTreeState().xp).toBe(30);
  });

  it('never writes to the server: the tree service has no write method', async () => {
    expect(Object.keys(treeService)).toEqual(['getTree']);
  });

  it('refuses to apply growth before init for the current user', () => {
    login(USER_A);
    expect(() => applyServerGrowth(growth('t1', 10))).toThrow(TreeIdentityError);
  });
});

// ── Two users, one browser ─────────────────────────────────────────────────

describe('two users sharing the same browser storage', () => {
  it("does not load user A's stored copy for user B", async () => {
    login(USER_A);
    serverRecords.set('user-a', json(200, ['a1']));
    await initTreeStorage();
    await flush();

    logout();
    login(USER_B);
    serverRecords.set('user-b', json(10, ['b1']));

    const bState = await initTreeStorage();

    expect(bState.xp).toBe(10);
    expect([...bState.awardedTaskIds]).toEqual(['b1']);
    expect(getTreeState().xp).toBe(10);
  });

  it("user A's higher stored XP never shows up for user B", async () => {
    idb.set('growth_tree:user-a', json(500, ['a1']));
    login(USER_B);
    serverRecords.set('user-b', json(10));

    const b = await initTreeStorage();
    await flush();

    expect(b.xp).toBe(10);
    expect(idb.get('growth_tree:user-a')).toMatchObject({ xp: 500 }); // A's record untouched
  });

  it("user A's awarded ids do not leak into user B's tree", async () => {
    login(USER_A);
    serverRecords.set('user-a', json(0));
    await initTreeStorage();
    applyServerGrowth(growth('shared-task', 10));
    await flush();

    logout();
    login(USER_B);
    const bState = await initTreeStorage();

    expect(bState.awardedTaskIds.has('shared-task')).toBe(false);
    expect(bState.xp).toBe(0);
  });

  it('logout → login A → logout → login B → logout → login A restores each user their own copy (offline)', async () => {
    login(USER_A);
    serverRecords.set('user-a', json(70, ['a1']));
    await initTreeStorage();
    await flush();
    logout();

    login(USER_B);
    serverRecords.set('user-b', json(20, ['b1']));
    await initTreeStorage();
    await flush();
    logout();

    serverOffline = true;

    login(USER_A);
    resetCache();
    const a = await initTreeStorage();
    expect(a.xp).toBe(70);
    expect([...a.awardedTaskIds]).toEqual(['a1']);
    logout();

    login(USER_B);
    resetCache();
    const b2 = await initTreeStorage();
    expect(b2.xp).toBe(20);
    expect([...b2.awardedTaskIds]).toEqual(['b1']);
    expect(scopedKeys().sort()).toEqual(['growth_tree:user-a', 'growth_tree:user-b']);
  });

  it("never serves user A's cached state to user B, and refuses to apply growth before B is initialised", async () => {
    login(USER_A);
    serverRecords.set('user-a', json(80, ['a1']));
    await initTreeStorage();
    await flush();

    logout();
    login(USER_B); // no initTreeStorage() yet for B

    expect(getTreeState().xp).toBe(0);
    expect(() => applyServerGrowth(growth('a2', 90))).toThrow(TreeIdentityError);
    await flush();

    expect(idb.has('growth_tree:user-b')).toBe(false);
  });

  it('discards an in-flight init if the account changes before the server responds', async () => {
    login(USER_A);
    idb.set('growth_tree:user-a', json(300, ['a1']));

    let release: (value: TreeStateJSON) => void = () => undefined;
    vi.mocked(treeService.getTree).mockImplementationOnce(
      () => new Promise<TreeStateJSON>((resolve) => { release = resolve; }),
    );

    const pending = initTreeStorage();
    await flush();
    logout();
    login(USER_B);
    release(json(0));

    await expect(pending).rejects.toBeInstanceOf(TreeIdentityError);
    await flush();

    expect(idb.has('growth_tree:user-b')).toBe(false);
    expect(getTreeState().xp).toBe(0); // stale A result was not cached for B
    expect(idb.get('growth_tree:user-a')).toMatchObject({ xp: 300 });
  });

  it('clearTreeState only removes the current user’s record', async () => {
    idb.set('growth_tree:user-a', json(10));
    idb.set('growth_tree:user-b', json(20));
    login(USER_A);
    await initTreeStorage();

    await clearTreeState();

    expect(idb.has('growth_tree:user-a')).toBe(false);
    expect(idb.get('growth_tree:user-b')).toMatchObject({ xp: 20 });
  });
});

// ── Missing identity ───────────────────────────────────────────────────────

describe('no authenticated user', () => {
  it('fails explicitly and touches neither local nor server state', async () => {
    await expect(initTreeStorage()).rejects.toBeInstanceOf(TreeIdentityError);
    expect(() => applyServerGrowth(growth('t', 10))).toThrow(TreeIdentityError);
    await expect(clearTreeState()).rejects.toBeInstanceOf(TreeIdentityError);

    expect(treeService.getTree).not.toHaveBeenCalled();
    expect(idb.size).toBe(0);
  });
});

// ── Legacy unscoped data ───────────────────────────────────────────────────

describe('legacy unscoped storage', () => {
  it('is never assigned to whichever user logs in next, and is deleted', async () => {
    idb.set('growth_tree', json(999, ['legacy-task']));
    localStorage.setItem('halotask:growth_tree', JSON.stringify(json(888, ['legacy-ls-task'])));

    login(USER_B);
    serverRecords.set('user-b', json(10));
    const bState = await initTreeStorage();
    await flush();

    expect(bState.xp).toBe(10);
    expect(bState.awardedTaskIds.has('legacy-task')).toBe(false);
    expect(bState.awardedTaskIds.has('legacy-ls-task')).toBe(false);
    expect(idb.has('growth_tree')).toBe(false);
    expect(localStorage.getItem('halotask:growth_tree')).toBeNull();
    expect(scopedKeys()).toEqual(['growth_tree:user-b']);
  });

  it('is deleted even when the server is unreachable, without leaking into local state', async () => {
    idb.set('growth_tree', json(999));
    serverOffline = true;
    login(USER_A);

    const aState = await initTreeStorage();

    expect(aState.xp).toBe(0);
    expect(idb.has('growth_tree')).toBe(false);
  });
});
