import { useCallback, useState } from 'react';

export const useTaskSelection = () => {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  const toggleSelect = useCallback((taskId: string) => {
    setSelectedIds((current) =>
      current.includes(taskId) ? current.filter((id) => id !== taskId) : [...current, taskId],
    );
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedIds([]);
  }, []);

  const selectAll = useCallback((taskIds: string[]) => {
    setSelectedIds(Array.from(new Set(taskIds)));
  }, []);

  const retainOnly = useCallback((allowedIds: string[]) => {
    const allowed = new Set(allowedIds);
    setSelectedIds((current) => {
      const next = current.filter((id) => allowed.has(id));

      if (next.length === current.length && next.every((id, index) => id === current[index])) {
        return current;
      }

      return next;
    });
  }, []);

  return {
    selectedIds,
    toggleSelect,
    clearSelection,
    selectAll,
    retainOnly,
  };
};
