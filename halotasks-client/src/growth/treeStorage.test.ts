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
  treeService: { getTree: vi.fn(), patchTree: vi.fn() },
}));

import { useAuthStore } from '../store/authStore';
import { treeService } from '../services/treeService';
import { awardXpForCompletion } from './treeLogic';
import {
  clearTreeState,
  getTreeState,
  initTreeStorage,
  resetCache,
  setTreeState,
  TreeIdentityError,
} from './treeStorage';
import type { TreeState, TreeStateJSON } from './treeTypes';

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

const state = (xp: number, awardedTaskIds: string[] = []): TreeState => ({
  ...json(xp),
  awardedTaskIds: new Set(awardedTaskIds),
});

// Fake server: records are keyed by whichever user's token is active when the
// request is made — mirroring how the real API derives the user from the JWT.
const serverRecords = new Map<string, TreeStateJSON>();
const patches: { userId: string | null; body: Partial<TreeStateJSON> }[] = [];
let serverOffline = false;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const scopedKeys = () => [...idb.keys()].filter((k) => k.startsWith('growth_tree:'));

beforeEach(() => {
  idb.clear();
  localStorage.clear();
  serverRecords.clear();
  patches.length = 0;
  serverOffline = false;
  resetCache();
  logout();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  vi.mocked(treeService.getTree).mockReset().mockImplementation(async () => {
    const userId = currentUserId();
    if (serverOffline || !userId) throw new Error('network');
    return serverRecords.get(userId) ?? json(0);
  });

  vi.mocked(treeService.patchTree).mockReset().mockImplementation(async (body) => {
    const userId = currentUserId();
    patches.push({ userId, body });
    if (!userId) throw new Error('unauthenticated');
    const existing = serverRecords.get(userId) ?? json(0);
    if (typeof body.xp === 'number' && body.xp < existing.xp) throw new Error('XP cannot decrease');
    const next = { ...existing, ...body } as TreeStateJSON;
    serverRecords.set(userId, next);
    return next;
  });
});

// ── Single-user behaviour is preserved ─────────────────────────────────────

describe('single user', () => {
  it('starts from the initial state, persists under a user-scoped key, and pushes to the server', async () => {
    login(USER_A);
    const initial = await initTreeStorage();
    expect(initial.xp).toBe(0);

    setTreeState(state(30, ['t1']));
    await flush();

    expect(getTreeState().xp).toBe(30);
    expect(scopedKeys()).toEqual(['growth_tree:user-a']);
    expect((idb.get('growth_tree:user-a') as TreeStateJSON).xp).toBe(30);
    expect(serverRecords.get('user-a')?.xp).toBe(30);
  });

  it('keeps working offline for the current user across an app restart', async () => {
    login(USER_A);
    await initTreeStorage();
    setTreeState(state(40, ['t1', 't2']));
    await flush();

    serverOffline = true;
    resetCache(); // simulates a fresh page load
    const restored = await initTreeStorage();

    expect(restored.xp).toBe(40);
    expect([...restored.awardedTaskIds].sort()).toEqual(['t1', 't2']);
  });

  it('still merges: higher server XP wins and awardedTaskIds are unioned; local-ahead is pushed', async () => {
    login(USER_A);
    idb.set('growth_tree:user-a', json(50, ['local']));
    serverRecords.set('user-a', json(20, ['remote']));

    const merged = await initTreeStorage();
    await flush();

    expect(merged.xp).toBe(50);
    expect([...merged.awardedTaskIds].sort()).toEqual(['local', 'remote']);
    expect(patches.filter((p) => p.userId === 'user-a')).toHaveLength(1);

    resetCache();
    serverRecords.set('user-a', json(90, ['remote']));
    const serverWins = await initTreeStorage();
    expect(serverWins.xp).toBe(90);
  });
});

// ── Two users, one browser ─────────────────────────────────────────────────

describe('two users sharing the same browser storage', () => {
  it("does not load user A's local state for user B", async () => {
    login(USER_A);
    await initTreeStorage();
    setTreeState(state(200, ['a1']));
    await flush();

    logout();
    login(USER_B);
    serverRecords.set('user-b', json(10, ['b1']));

    const bState = await initTreeStorage();

    expect(bState.xp).toBe(10);
    expect([...bState.awardedTaskIds]).toEqual(['b1']);
    expect(getTreeState().xp).toBe(10);
  });

  it("user A's higher local XP never overwrites user B's lower server XP", async () => {
    idb.set('growth_tree:user-a', json(500, ['a1']));
    login(USER_B);
    serverRecords.set('user-b', json(10));

    await initTreeStorage();
    await flush();

    expect(serverRecords.get('user-b')?.xp).toBe(10);
    expect(patches).toEqual([]); // nothing pushed for B: B's local (0) is not ahead of B's server (10)
    expect(idb.get('growth_tree:user-a')).toMatchObject({ xp: 500 }); // A's record untouched
  });

  it("user A's awardedTaskIds do not suppress rewards for user B", async () => {
    login(USER_A);
    await initTreeStorage();
    const { state: afterA, event: eventA } = awardXpForCompletion(getTreeState(), 'shared-task', true);
    expect(eventA?.xpGained).toBe(10);
    setTreeState(afterA);
    await flush();

    logout();
    login(USER_B);
    const bState = await initTreeStorage();
    expect(bState.awardedTaskIds.has('shared-task')).toBe(false);

    const { state: afterB, event: eventB } = awardXpForCompletion(bState, 'shared-task', true);
    expect(eventB?.xpGained).toBe(10);
    expect(afterB.awardedTaskIds.has('shared-task')).toBe(true);
    expect(serverRecords.get('user-b')?.awardedTaskIds ?? []).not.toContain('a1');
  });

  it('logout → login A → logout → login B → logout → login A restores each user their own state (offline)', async () => {
    serverOffline = true;

    login(USER_A);
    await initTreeStorage();
    setTreeState(state(70, ['a1']));
    await flush();
    logout();

    login(USER_B);
    const b = await initTreeStorage();
    expect(b.xp).toBe(0);
    setTreeState(state(20, ['b1']));
    await flush();
    logout();

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

  it("never serves user A's cached state to user B, and refuses to persist before B is initialised", async () => {
    login(USER_A);
    await initTreeStorage();
    setTreeState(state(80, ['a1']));
    await flush();
    patches.length = 0;

    logout();
    login(USER_B); // no initTreeStorage() yet for B

    expect(getTreeState().xp).toBe(0);
    expect(() => setTreeState(state(80, ['a1']))).toThrow(TreeIdentityError);
    await flush();

    expect(idb.has('growth_tree:user-b')).toBe(false);
    expect(patches).toEqual([]);
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

    expect(patches).toEqual([]);
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
    expect(() => setTreeState(state(10))).toThrow(TreeIdentityError);
    await expect(clearTreeState()).rejects.toBeInstanceOf(TreeIdentityError);

    expect(treeService.getTree).not.toHaveBeenCalled();
    expect(treeService.patchTree).not.toHaveBeenCalled();
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
    expect(patches).toEqual([]);
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
