import { useCallback, useEffect, useState } from 'react';
import { awardXpForCompletion } from '../growth/treeLogic';
import {
  getTreeState,
  initTreeStorage,
  setTreeState,
  TreeIdentityError,
} from '../growth/treeStorage';
import type { TreeState } from '../growth/treeTypes';
import { useAuthStore } from '../store/authStore';

export function useDashboardGrowth() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const [treeState, setTreeStateLocal] = useState<TreeState | null>(null);

  // Re-runs when the authenticated user changes so one account's tree is never
  // shown (or written) for another.
  useEffect(() => {
    setTreeStateLocal(null);
    if (!userId) return undefined;

    let cancelled = false;
    initTreeStorage()
      .then((initialTreeState) => {
        if (!cancelled) setTreeStateLocal(initialTreeState);
      })
      .catch((err) => {
        if (err instanceof TreeIdentityError) {
          console.warn('[useDashboardGrowth] Growth Tree init skipped:', err.message);
        } else {
          console.error('[useDashboardGrowth] Growth Tree init failed:', err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [userId]);

  const processGrowthForCompletion = useCallback((taskId: string) => {
    setTreeStateLocal((current) => {
      const baseState = current ?? getTreeState();
      const { state: nextState } = awardXpForCompletion(baseState, taskId, true);
      try {
        setTreeState(nextState); // updates cache + persists storage
      } catch (err) {
        // Identity mismatch: do not apply or persist an award computed for another user.
        console.error('[useDashboardGrowth] Growth award not persisted:', err);
        return current;
      }
      return nextState;
    });
  }, []);

  return {
    treeState,
    processGrowthForCompletion,
  };
}
