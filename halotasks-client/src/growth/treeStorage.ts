/**
 * Growth Tree Storage
 * 
 * Handles localStorage persistence and serialization.
 * Local-first for now, can sync to backend later.
 */

import { TreeState, TreeStateJSON } from './treeTypes';
import { createInitialTreeState, updateStreakState } from './treeLogic';

const STORAGE_KEY = 'halotask:growth_tree';

/**
 * Serialize TreeState to JSON
 */
const serializeState = (state: TreeState): TreeStateJSON => {
  return {
    xp: state.xp,
    leaves: state.leaves,
    streakDays: state.streakDays,
    lastActiveDate: state.lastActiveDate,
    health: state.health,
    stage: state.stage,
    lastCalculatedAt: state.lastCalculatedAt,
    awardedTaskIds: Array.from(state.awardedTaskIds),
  };
};

/**
 * Deserialize JSON to TreeState
 */
const deserializeState = (json: TreeStateJSON): TreeState => {
  return {
    xp: json.xp,
    leaves: json.leaves,
    streakDays: json.streakDays,
    lastActiveDate: json.lastActiveDate,
    health: json.health,
    stage: json.stage,
    lastCalculatedAt: json.lastCalculatedAt,
    awardedTaskIds: new Set(json.awardedTaskIds),
  };
};

/**
 * Load tree state from localStorage
 * 
 * Returns fresh state if missing or corrupted.
 * Automatically updates streak on load.
 */
export const loadTreeState = (): TreeState => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) {
      return createInitialTreeState();
    }

    const json = JSON.parse(stored) as TreeStateJSON;
    let state = deserializeState(json);

    // Recalculate streak on load (in case days passed while offline)
    state = updateStreakState(state);

    return state;
  } catch (error) {
    console.warn('[GrowthTree] Failed to load state from storage, using defaults', error);
    return createInitialTreeState();
  }
};

/**
 * Save tree state to localStorage
 */
export const saveTreeState = (state: TreeState): void => {
  try {
    const json = serializeState(state);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
  } catch (error) {
    console.warn('[GrowthTree] Failed to save state to storage', error);
  }
};

/**
 * Clear all growth data (for testing or reset)
 */
export const clearTreeState = (): void => {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn('[GrowthTree] Failed to clear storage', error);
  }
};

/**
 * Get current tree state, with auto-load if not already loaded
 */
let cachedState: TreeState | null = null;

export const getTreeState = (): TreeState => {
  if (!cachedState) {
    cachedState = loadTreeState();
  }
  return cachedState;
};

/**
 * Update cached state and persist
 */
export const setTreeState = (newState: TreeState): void => {
  cachedState = newState;
  saveTreeState(newState);
};

/**
 * Reset cache (for testing)
 */
export const resetCache = (): void => {
  cachedState = null;
};
