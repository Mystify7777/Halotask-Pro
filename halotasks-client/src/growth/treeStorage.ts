/**
 * Growth Tree Storage (Issue #24: the SERVER is authoritative)
 *
 *   - XP and the awarded-task ledger are created only by the server, as a side effect of completing a
 *     task (`growth` in the task response). This module never computes or pushes reward state:
 *     there is no write to `/api/tree`, and no "higher XP wins" merge.
 *   - The in-memory cache holds the last SERVER-CONFIRMED tree for the current user. IndexedDB
 *     (`growth_tree:<userId>`) holds a copy of it purely so an offline start has something to show.
 *   - On init: fetch the server tree and adopt it as is. Only if the server cannot be reached is the
 *     local copy used (display fallback, never pushed anywhere).
 *   - `applyServerGrowth` adopts the tree from a task response. XP never decreases on the server, so a
 *     response older than what we already hold (bulk requests can finish out of order) is ignored.
 *   - Offline completions are only an in-memory PREVIEW in React state (useDashboardGrowth); they are
 *     never stored here. The queued request makes the server award them, and its response replaces the
 *     preview.
 *
 * Identity contract:
 *   - The user id comes from `useAuthStore.getState().user.id` (issued by the
 *     server at login; the same login response carries the token the API
 *     client sends, so the server writes to the same user we key locally).
 *   - Nothing here reads or writes without a user id. Missing identity, or an
 *     identity change while an async step is in flight, raises a
 *     `TreeIdentityError` instead of silently falling back to shared state.
 *   - Legacy unscoped data (`growth_tree` in IndexedDB, `halotask:growth_tree`
 *     in localStorage) has no provable owner. It is never read or migrated;
 *     it is deleted on init.
 *   - `authStore.clearAuth()` intentionally does not touch this module: keys
 *     and cache are owner-scoped, so a later user can never see them.
 */

import { offlineDb } from '../offline/db';
import { useAuthStore } from '../store/authStore';
import { GrowthResult, TreeState, TreeStateJSON } from './treeTypes';
import { createInitialTreeState, updateStreakState } from './treeLogic';
import { treeService } from '../services/treeService';

const IDB_KEY_PREFIX  = 'growth_tree:';
const LEGACY_IDB_KEY  = 'growth_tree';          // legacy, unscoped — never read
const LEGACY_LS_KEY   = 'halotask:growth_tree'; // legacy, unscoped — never read

/** Raised when the Growth Tree is used without, or across, user identities. */
export class TreeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TreeIdentityError';
  }
}

// ── Identity ───────────────────────────────────────────────────────────────

const getCurrentUserId = (): string | null => useAuthStore.getState().user?.id || null;

const requireUserId = (): string => {
  const userId = getCurrentUserId();
  if (!userId) {
    throw new TreeIdentityError('Growth Tree requires an authenticated user');
  }
  return userId;
};

const idbKeyFor = (userId: string): string => `${IDB_KEY_PREFIX}${userId}`;

// ── Serialisation ──────────────────────────────────────────────────────────

const serialize = (state: TreeState): TreeStateJSON => ({
  xp:               state.xp,
  leaves:           state.leaves,
  streakDays:       state.streakDays,
  lastActiveDate:   state.lastActiveDate,
  health:           state.health,
  stage:            state.stage,
  lastCalculatedAt: state.lastCalculatedAt,
  awardedTaskIds:   Array.from(state.awardedTaskIds),
});

const deserialize = (json: TreeStateJSON): TreeState => ({
  xp:               json.xp,
  leaves:           json.leaves,
  streakDays:       json.streakDays,
  lastActiveDate:   json.lastActiveDate,
  health:           json.health,
  stage:            json.stage,
  lastCalculatedAt: json.lastCalculatedAt,
  awardedTaskIds:   new Set(json.awardedTaskIds),
});

// ── In-memory cache (owner-scoped) ─────────────────────────────────────────

let cache: { userId: string; state: TreeState } | null = null;

// ── Legacy unscoped data ───────────────────────────────────────────────────

/**
 * Legacy data was written to one global key with no owner recorded, so it
 * cannot be attributed to any account. Delete it rather than guess. The
 * server copy (whatever was successfully synchronized) is the recovery path for
 * the real owner.
 */
const purgeLegacyUnscopedState = async (): Promise<void> => {
  try {
    localStorage.removeItem(LEGACY_LS_KEY);
  } catch (err) {
    console.warn('[treeStorage] Could not remove legacy localStorage tree data:', err);
  }
  try {
    await offlineDb.remove(LEGACY_IDB_KEY);
  } catch (err) {
    console.warn('[treeStorage] Could not remove legacy IndexedDB tree data:', err);
  }
};

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * initTreeStorage — call once per authenticated session (and again if the user changes).
 *
 * 1. Delete legacy unscoped data (never migrated — see above).
 * 2. Fetch the server tree; if it answers, it IS the state (the local copy is not consulted).
 * 3. Only if the server cannot be reached: fall back to this user's last stored copy (or an empty tree).
 * 4. Apply the display-only streak check (days may have passed while the app was closed).
 *
 * Nothing is pushed to the server. Throws TreeIdentityError if there is no authenticated user, or if
 * the authenticated user changes while init is in flight (the result is then discarded).
 */
export const initTreeStorage = async (): Promise<TreeState> => {
  const userId = requireUserId();
  const idbKey = idbKeyFor(userId);

  const assertSameUser = (): void => {
    if (getCurrentUserId() !== userId) {
      throw new TreeIdentityError(
        'Authenticated user changed during Growth Tree init; discarding result',
      );
    }
  };

  await purgeLegacyUnscopedState();

  let serverState: TreeState | null = null;
  try {
    const serverJson = await treeService.getTree();
    if (serverJson) serverState = deserialize(serverJson);
  } catch (err) {
    console.warn('[treeStorage] Could not fetch server state, falling back to the stored copy:', err);
  }
  // The token may have changed (logout, 401, account switch) while the request was in flight.
  assertSameUser();

  let state: TreeState;
  if (serverState) {
    state = serverState;
  } else {
    try {
      const stored = await offlineDb.get<TreeStateJSON>(idbKey);
      state = stored ? deserialize(stored) : createInitialTreeState();
    } catch (err) {
      console.warn('[treeStorage] Could not read local state, starting fresh:', err);
      state = createInitialTreeState();
    }
    assertSameUser();
  }

  state = updateStreakState(state);
  cache = { userId, state };

  if (serverState) {
    offlineDb.set(idbKey, serialize(state)).catch((err) => {
      console.warn('[treeStorage] Failed to persist server state to IndexedDB:', err);
    });
  }

  return state;
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * getTreeState — synchronous read from in-memory cache.
 * Returns initial state if the cache is empty or belongs to a different user;
 * another user's cached state is never returned.
 */
export const getTreeState = (): TreeState => {
  if (!cache) {
    console.warn('[treeStorage] getTreeState called before initTreeStorage');
    return createInitialTreeState();
  }
  if (cache.userId !== getCurrentUserId()) {
    console.warn('[treeStorage] getTreeState called before init for the current user');
    return createInitialTreeState();
  }
  return cache.state;
};

/**
 * applyServerGrowth — adopt the tree the server returned with a task completion.
 *
 * The server's `treeState` is the truth, so it replaces the cached values wholesale (xp, leaves, streak,
 * health, stage, dates) — nothing is recomputed here. Two safeguards:
 *   - a response whose xp is LOWER than the cache is stale (XP never decreases server-side): ignored;
 *   - the ledger kept locally gains the task id when the server holds an award for it.
 *
 * Throws TreeIdentityError if the cache is not initialised for the current user, so a response can never
 * be applied to another account's tree. Returns the resulting cached state.
 */
export const applyServerGrowth = (growth: GrowthResult): TreeState => {
  const userId = requireUserId();
  if (!cache || cache.userId !== userId) {
    throw new TreeIdentityError(
      'Growth Tree is not initialised for the current user; refusing to apply server growth',
    );
  }

  if (growth.treeState.xp < cache.state.xp) return cache.state;

  const awardedTaskIds = new Set(cache.state.awardedTaskIds);
  if (growth.awarded || growth.reason === 'already_awarded') awardedTaskIds.add(growth.taskId);

  const next: TreeState = {
    xp: growth.treeState.xp,
    leaves: growth.treeState.leaves,
    streakDays: growth.treeState.streakDays,
    lastActiveDate: growth.treeState.lastActiveDate,
    health: growth.treeState.health,
    stage: growth.treeState.stage,
    lastCalculatedAt: growth.treeState.lastCalculatedAt,
    awardedTaskIds,
  };

  cache = { userId, state: next };
  offlineDb.set(idbKeyFor(userId), serialize(next)).catch((err) => {
    console.warn('[treeStorage] Failed to persist server growth to IndexedDB:', err);
  });
  return next;
};

/** clearTreeState — wipes the current user's IndexedDB record and cache. */
export const clearTreeState = async (): Promise<void> => {
  const userId = requireUserId();
  if (cache?.userId === userId) cache = null;
  await offlineDb.remove(idbKeyFor(userId));
};

/** resetCache — for testing only. */
export const resetCache = (): void => {
  cache = null;
};
