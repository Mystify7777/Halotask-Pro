/**
 * Growth Tree Storage
 *
 * Local-first with server sync, strictly scoped to the authenticated user:
 *   - Every local record lives under a per-user IndexedDB key
 *     (`growth_tree:<userId>`) and the in-memory cache remembers its owner.
 *   - On init: fetch from server, merge with THIS user's local state
 *     (higher XP wins), union awardedTaskIds from both sources.
 *   - On save: update local cache + IndexedDB immediately,
 *     push to server as fire-and-forget.
 *
 * Offline usage still works for the current user — their local state is the
 * source of truth during a session, and the server acts as the cross-device
 * persistence layer.
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
 *     and cache are owner-scoped, so a later user can never see them, and
 *     wiping on logout/401 would destroy the previous user's unsynced offline
 *     progress.
 */

import { offlineDb } from '../offline/db';
import { useAuthStore } from '../store/authStore';
import { TreeState, TreeStateJSON } from './treeTypes';
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

// ── Merge strategy ─────────────────────────────────────────────────────────
// "Higher XP wins" — takes the state with more progress, then unions
// awardedTaskIds from both sources to prevent double-awarding on either device.
// Both inputs are always the SAME user's state (scoped local + that user's server record).

const mergeStates = (local: TreeState, server: TreeState): TreeState => {
  const winner = server.xp > local.xp ? server : local;
  return {
    ...winner,
    // Union task IDs so neither device can re-award already-completed tasks
    awardedTaskIds: new Set([...local.awardedTaskIds, ...server.awardedTaskIds]),
  };
};

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
 * initTreeStorage — call once per authenticated session (and again if the
 * user changes).
 *
 * 1. Delete legacy unscoped data (never migrated — see above).
 * 2. Load this user's local state from IndexedDB.
 * 3. Fetch server state and merge (higher XP wins).
 * 4. If local was ahead, push the merged state back to the server.
 * 5. Run streak recalculation (days may have passed while app was closed).
 *
 * Throws TreeIdentityError if there is no authenticated user, or if the
 * authenticated user changes while init is in flight (the result is then
 * discarded: nothing is cached, persisted or pushed for the stale user).
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

  // ── Step 1: discard legacy unscoped data ────────────────────────────────
  await purgeLegacyUnscopedState();

  // ── Step 2: Load this user's local state ────────────────────────────────
  let localState: TreeState;
  try {
    const stored = await offlineDb.get<TreeStateJSON>(idbKey);
    localState = stored ? deserialize(stored) : createInitialTreeState();
  } catch (err) {
    console.warn('[treeStorage] Could not read local state, starting fresh:', err);
    localState = createInitialTreeState();
  }
  assertSameUser();

  // ── Step 3: Fetch server state and merge ────────────────────────────────
  let serverState: TreeState | null = null;
  try {
    const serverJson = await treeService.getTree();
    if (serverJson) serverState = deserialize(serverJson);
  } catch (err) {
    // Server unreachable — continue with this user's local state
    console.warn('[treeStorage] Could not fetch server state, using local only:', err);
  }
  // The token may have changed (logout, 401, account switch) while the request
  // was in flight. Never merge or push across an identity change.
  assertSameUser();

  let mergedState = localState;
  if (serverState) {
    mergedState = mergeStates(localState, serverState);

    // ── Step 4: Push merged state back if local was ahead ─────────────────
    if (localState.xp > serverState.xp) {
      treeService.patchTree(serialize(mergedState)).catch((err) => {
        console.warn('[treeStorage] Failed to push local state to server:', err);
      });
    }
  }

  // ── Step 5: Run streak recalculation ────────────────────────────────────
  mergedState = updateStreakState(mergedState);

  cache = { userId, state: mergedState };

  // Persist merged state to this user's IndexedDB record
  offlineDb.set(idbKey, serialize(mergedState)).catch((err) => {
    console.warn('[treeStorage] Failed to persist merged state to IndexedDB:', err);
  });

  return mergedState;
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
 * setTreeState — update cache immediately, persist to IndexedDB and server.
 * Both persistence calls are fire-and-forget so React state updates stay sync.
 *
 * Throws TreeIdentityError if there is no authenticated user, or if the cache
 * has not been initialised for the current user (the state in hand could have
 * been derived from another account).
 */
export const setTreeState = (newState: TreeState): void => {
  const userId = requireUserId();
  if (!cache || cache.userId !== userId) {
    throw new TreeIdentityError(
      'Growth Tree is not initialised for the current user; refusing to persist',
    );
  }

  cache = { userId, state: newState };
  const json = serialize(newState);

  // Local persistence
  offlineDb.set(idbKeyFor(userId), json).catch((err) => {
    console.warn('[treeStorage] Failed to persist to IndexedDB:', err);
  });

  // Server persistence — fire-and-forget
  treeService.patchTree(json).catch((err) => {
    console.warn('[treeStorage] Failed to push state to server:', err);
  });
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
