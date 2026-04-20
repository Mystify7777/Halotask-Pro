import { useCallback, useEffect, useState } from 'react';
import { awardXpForCompletion } from '../growth/treeLogic';
import { getTreeState, setTreeState } from '../growth/treeStorage';
import type { TreeState } from '../growth/treeTypes';

export function useDashboardGrowth() {
  const [treeState, setTreeStateLocal] = useState<TreeState | null>(null);

  useEffect(() => {
    const initialTreeState = getTreeState();
    setTreeStateLocal(initialTreeState);
    setTreeState(initialTreeState);
  }, []);

  const processGrowthForCompletion = useCallback((taskId: string) => {
    setTreeStateLocal((current) => {
      const baseState = current ?? getTreeState();
      const { state: nextState } = awardXpForCompletion(baseState, taskId, true);
      setTreeState(nextState);
      return nextState;
    });
  }, []);

  return {
    treeState,
    processGrowthForCompletion,
  };
}
