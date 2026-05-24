/**
 * Growth Tree Storage
 *
 * Local-first with server sync:
 *   - On init: fetch from server, merge with local (higher XP wins),
 *     union awardedTaskIds from both sources.
 *   - On save: update local cache + IndexedDB immediately,
 *     push to server as fire-and-forget.
 *
 * This means offline usage always works — local state is the source of truth
 * during a session, and server acts as the cross-device persistence layer.
 */

import { offlineDb } from '../offline/db';
import { TreeState, TreeStateJSON } from './treeTypes';
import { createInitialTreeState, updateStreakState } from './treeLogic';
import { treeService } from '../services/treeService';

const IDB_KEY        = 'growth_tree';
const LS_MIGRATE_KEY = 'halotask:growth_tree'; // legacy localStorage key

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

const mergeStates = (local: TreeState, server: TreeState): TreeState => {
  const winner = server.xp > local.xp ? server : local;
  return {
    ...winner,
    // Union task IDs so neither device can re-award already-completed tasks
    awardedTaskIds: new Set([...local.awardedTaskIds, ...server.awardedTaskIds]),
  };
};

// ── In-memory cache ────────────────────────────────────────────────────────

let cachedState: TreeState | null = null;

// ── Init ───────────────────────────────────────────────────────────────────

/**
 * initTreeStorage — call once on app start.
 *
 * 1. Migrate any legacy localStorage entry to IndexedDB.
 * 2. Load local state from IndexedDB.
 * 3. Fetch server state and merge (higher XP wins).
 * 4. If local was ahead, push the merged state back to the server.
 * 5. Run streak recalculation (days may have passed while app was closed).
 */
export const initTreeStorage = async (): Promise<TreeState> => {
  // ── Step 1: localStorage migration ──────────────────────────────────────
  try {
    const legacyRaw = localStorage.getItem(LS_MIGRATE_KEY);
    if (legacyRaw) {
      const legacyJson = JSON.parse(legacyRaw) as TreeStateJSON;
      const existing = await offlineDb.get<TreeStateJSON>(IDB_KEY);
      if (!existing) await offlineDb.set(IDB_KEY, legacyJson);
      localStorage.removeItem(LS_MIGRATE_KEY);
    }
  } catch {
    // Corrupted legacy data — ignore
  }

  // ── Step 2: Load local state ─────────────────────────────────────────────
  let localState: TreeState;
  try {
    const stored = await offlineDb.get<TreeStateJSON>(IDB_KEY);
    localState = stored ? deserialize(stored) : createInitialTreeState();
  } catch {
    localState = createInitialTreeState();
  }

  // ── Step 3: Fetch server state and merge ─────────────────────────────────
  let mergedState = localState;
  try {
    const serverJson = await treeService.getTree();
    if (serverJson) {
      const serverState = deserialize(serverJson);
      mergedState = mergeStates(localState, serverState);

      // ── Step 4: Push merged state back if local was ahead ───────────────
      if (localState.xp > serverState.xp) {
        treeService.patchTree(serialize(mergedState)).catch((err) => {
          console.warn('[treeStorage] Failed to push local state to server:', err);
        });
      }
    }
  } catch (err) {
    // Server unreachable or not authenticated — continue with local state
    console.warn('[treeStorage] Could not fetch server state, using local only:', err);
  }

  // ── Step 5: Run streak recalculation ─────────────────────────────────────
  mergedState = updateStreakState(mergedState);

  cachedState = mergedState;

  // Persist merged state to IndexedDB
  offlineDb.set(IDB_KEY, serialize(mergedState)).catch(() => {});

  return mergedState;
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * getTreeState — synchronous read from in-memory cache.
 * Returns initial state if called before initTreeStorage settles.
 */
export const getTreeState = (): TreeState => {
  if (!cachedState) {
    console.warn('[treeStorage] getTreeState called before initTreeStorage');
    return createInitialTreeState();
  }
  return cachedState;
};

/**
 * setTreeState — update cache immediately, persist to IndexedDB and server.
 * Both persistence calls are fire-and-forget so React state updates stay sync.
 */
export const setTreeState = (newState: TreeState): void => {
  cachedState = newState;
  const json = serialize(newState);

  // Local persistence
  offlineDb.set(IDB_KEY, json).catch((err) => {
    console.warn('[treeStorage] Failed to persist to IndexedDB:', err);
  });

  // Server persistence — fire-and-forget
  treeService.patchTree(json).catch((err) => {
    console.warn('[treeStorage] Failed to push state to server:', err);
  });
};

/** clearTreeState — wipes IndexedDB cache and resets in-memory state. */
export const clearTreeState = async (): Promise<void> => {
  cachedState = null;
  await offlineDb.remove(IDB_KEY);
};

/** resetCache — for testing only. */
export const resetCache = (): void => {
  cachedState = null;
};
