import { useMemo } from 'react';
import { Priority, Task } from '../types/task';
import { normalizeTag } from '../utils/tagHelpers';

export type FilterMode = 'all' | 'active' | 'completed';

type UseTaskFiltersArgs = {
  tasks: Task[];
  search: string;
  filterMode: FilterMode;
  priorityFilter: 'all' | Priority;
  tagFilter: string | null;
};

export const useTaskFilters = ({
  tasks,
  search,
  filterMode,
  priorityFilter,
  tagFilter,
}: UseTaskFiltersArgs) => {
  return useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return tasks.filter((task) => {
      if (filterMode === 'active' && task.completed) {
        return false;
      }

      if (filterMode === 'completed' && !task.completed) {
        return false;
      }

      if (priorityFilter !== 'all' && task.priority !== priorityFilter) {
        return false;
      }

      if (tagFilter) {
        const hasTag = task.tags.some((tag) => normalizeTag(tag) === tagFilter);
        if (!hasTag) {
          return false;
        }
      }

      if (!normalizedSearch) {
        return true;
      }

      return (
        task.title.toLowerCase().includes(normalizedSearch) ||
        task.description.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [tasks, search, filterMode, priorityFilter, tagFilter]);
};
