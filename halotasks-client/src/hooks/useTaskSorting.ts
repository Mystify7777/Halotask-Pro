import { useMemo } from 'react';
import { Task } from '../types/task';

export type TaskSortOption =
  | 'dueSoonest'
  | 'dueLatest'
  | 'priorityHigh'
  | 'priorityLow'
  | 'newest'
  | 'oldest'
  | 'shortestEstimate'
  | 'longestEstimate';

export const TASK_SORT_OPTIONS: Array<{ value: TaskSortOption; label: string }> = [
  { value: 'dueSoonest', label: 'Due Soonest' },
  { value: 'dueLatest', label: 'Due Latest' },
  { value: 'priorityHigh', label: 'Priority High to Low' },
  { value: 'priorityLow', label: 'Priority Low to High' },
  { value: 'newest', label: 'Newest Created' },
  { value: 'oldest', label: 'Oldest Created' },
  { value: 'shortestEstimate', label: 'Shortest Estimate' },
  { value: 'longestEstimate', label: 'Longest Estimate' },
];

const priorityRank: Record<string, number> = {
  low: 1,
  medium: 2,
  high: 3,
};

const toTimeOrNull = (value?: string) => {
  if (!value) {
    return null;
  }

  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
};

export const useTaskSorting = (tasks: Task[], sortBy: TaskSortOption) => {
  return useMemo(() => {
    const sorted = [...tasks];

    sorted.sort((a, b) => {
      const aDue = toTimeOrNull(a.dueDate);
      const bDue = toTimeOrNull(b.dueDate);

      switch (sortBy) {
        case 'dueSoonest': {
          if (aDue === null && bDue === null) {
            return 0;
          }

          if (aDue === null) {
            return 1;
          }

          if (bDue === null) {
            return -1;
          }

          return aDue - bDue;
        }
        case 'dueLatest': {
          if (aDue === null && bDue === null) {
            return 0;
          }

          if (aDue === null) {
            return 1;
          }

          if (bDue === null) {
            return -1;
          }

          return bDue - aDue;
        }
        case 'priorityHigh':
          return priorityRank[b.priority] - priorityRank[a.priority];
        case 'priorityLow':
          return priorityRank[a.priority] - priorityRank[b.priority];
        case 'newest': {
          const aCreated = toTimeOrNull(a.createdAt) ?? 0;
          const bCreated = toTimeOrNull(b.createdAt) ?? 0;
          return bCreated - aCreated;
        }
        case 'oldest': {
          const aCreated = toTimeOrNull(a.createdAt) ?? 0;
          const bCreated = toTimeOrNull(b.createdAt) ?? 0;
          return aCreated - bCreated;
        }
        case 'shortestEstimate':
          return a.estimatedMinutes - b.estimatedMinutes;
        case 'longestEstimate':
          return b.estimatedMinutes - a.estimatedMinutes;
        default:
          return 0;
      }
    });

    return sorted;
  }, [tasks, sortBy]);
};