import { useCallback, useEffect, useState } from 'react';
import { awardXpForCompletion } from '../growth/treeLogic';
import { getTreeState, initTreeStorage, setTreeState } from '../growth/treeStorage';
import type { TreeState } from '../growth/treeTypes';

export function useDashboardGrowth() {
  const [treeState, setTreeStateLocal] = useState<TreeState | null>(null);

  useEffect(() => {
    initTreeStorage().then((initialTreeState) => {
      setTreeStateLocal(initialTreeState);
    });
  }, []);

  const processGrowthForCompletion = useCallback((taskId: string) => {
    setTreeStateLocal((current) => {
      const baseState = current ?? getTreeState();
      const { state: nextState } = awardXpForCompletion(baseState, taskId, true);
      setTreeState(nextState); // updates cache + persists storage
      return nextState;
    });
  }, []);

  return {
    treeState,
    processGrowthForCompletion,
  };
}
