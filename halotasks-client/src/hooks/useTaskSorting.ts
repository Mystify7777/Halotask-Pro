import { useMemo } from 'react';
import { Task } from '../types/task';
import { compareDeadlines, dueDayKey } from '../utils/deadline';

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
      switch (sortBy) {
        // Exact deadline where there is one (due day, then due time); date-only tasks keep their established
        // by-day order, and tasks with no due date stay last in both directions.
        case 'dueSoonest':
          return compareDeadlines(a, b);
        case 'dueLatest': {
          if (dueDayKey(a.dueDate) === null || dueDayKey(b.dueDate) === null) return compareDeadlines(a, b);
          return compareDeadlines(b, a);
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