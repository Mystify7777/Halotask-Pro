import { useCallback, useEffect, useState } from 'react';
import { awardXpForCompletion } from '../growth/treeLogic';
import {
  applyServerGrowth as applyServerGrowthToStorage,
  getTreeState,
  initTreeStorage,
  TreeIdentityError,
} from '../growth/treeStorage';
import type { GrowthResult, TreeState } from '../growth/treeTypes';
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

  // OFFLINE ONLY: show the +10 straight away while the completion waits in the sync queue. This is a
  // preview held in React state — it is never stored, never sent to the server, and is replaced by the
  // server's tree as soon as the queued request is processed (applyServerGrowth).
  const previewGrowthForCompletion = useCallback((taskId: string) => {
    setTreeStateLocal((current) => {
      const baseState = current ?? getTreeState();
      return awardXpForCompletion(baseState, taskId, true).state;
    });
  }, []);

  // The server's answer to a completion (the `growth` block of a task response) becomes the tree.
  const applyServerGrowth = useCallback((growth: GrowthResult | undefined) => {
    if (!growth) return;
    try {
      const next = applyServerGrowthToStorage(growth);
      setTreeStateLocal(next);
    } catch (err) {
      // Identity mismatch: never show another account's tree.
      console.warn('[useDashboardGrowth] Server growth not applied:', err);
    }
  }, []);

  return {
    treeState,
    previewGrowthForCompletion,
    applyServerGrowth,
  };
}
