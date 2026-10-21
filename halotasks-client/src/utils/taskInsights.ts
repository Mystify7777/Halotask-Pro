import { Task } from '../types/task';
import { compareDeadlines, getDueState } from './deadline';

const getDayKey = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const parseTaskDate = (value?: string) => {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
};

// Section membership (Issue #10). Date-only tasks are classified by their due DAY against the local today (the day
// is the UTC date of the stored due date, never its local rendering, which is a day early west of UTC). A task with a
// due time is classified by its exact deadline: once that moment has passed it is overdue, even earlier the same day.
// Sections are disjoint except that `upcoming` is every not-yet-overdue task due today or later (as before).

export const getOverdueTasks = (tasks: Task[]) => {
  const now = new Date();
  return tasks.filter((task) => !task.completed && getDueState(task, now) === 'overdue');
};

export const getDueTodayTasks = (tasks: Task[]) => {
  const now = new Date();
  return tasks.filter((task) => !task.completed && getDueState(task, now) === 'today');
};

export const getUpcomingTasks = (tasks: Task[], limit = 5) => {
  const now = new Date();

  return tasks
    .filter((task) => {
      if (task.completed) return false;
      const state = getDueState(task, now);
      return state === 'today' || state === 'later';
    })
    .sort(compareDeadlines)
    .slice(0, limit);
};

export const getCompletedToday = (tasks: Task[]) => {
  const todayKey = getDayKey(new Date());

  return tasks.filter((task) => {
    if (!task.completed) {
      return false;
    }

    const completionDate = parseTaskDate(task.completedAt ?? task.updatedAt);
    if (!completionDate) {
      return false;
    }

    return getDayKey(completionDate) === todayKey;
  });
};

export const getEstimatedWorkload = (tasks: Task[]) => {
  const relevantTasks = [...getOverdueTasks(tasks), ...getDueTodayTasks(tasks)];

  const uniqueById = new Map(relevantTasks.map((task) => [task._id, task]));

  return Array.from(uniqueById.values()).reduce((total, task) => total + Math.max(0, task.estimatedMinutes), 0);
};

/**
 * Total estimated minutes of tasks marked completed today.
 * Prefers completedAt and falls back to updatedAt for older records.
 */
export const getWorkDoneToday = (tasks: Task[]): number => {
  return getCompletedToday(tasks).reduce(
    (total, task) => total + Math.max(0, task.estimatedMinutes),
    0,
  );
};
