import { Task } from '../types/task';
import { getExactDeadline, getStartInstant } from '../utils/deadline';

// Legacy deadline of a date-only task: the stored due date read as an instant (UTC midnight of the due day). Kept
// exactly as it was so tasks without a due time behave as before (Issue #10).
const parseDueDate = (dueDate?: string) => {
  if (!dueDate) {
    return null;
  }

  const parsed = new Date(dueDate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.getTime();
};

/**
 * The moment reminders treat as a task's deadline: the exact local time when the task has a due time, otherwise the
 * established date-only behaviour. null when the task has no due date.
 */
export const getDeadlineMs = (task: Task): number | null => getExactDeadline(task) ?? parseDueDate(task.dueDate);

/**
 * What identifies a task's schedule for reminder de-duplication (the in-session key and the notification tag). A task
 * that has no due time and no start time yields exactly what it always did (its due date, or 'no-due-date'), so
 * nothing already de-duplicated is re-sent. Changing a time is a new schedule and re-arms the reminder; a retry, a
 * sync, or an edit of any other field leaves it unchanged and sends nothing twice.
 */
export const reminderSchedulePart = (task: Task): string =>
  `${task.dueDate ?? 'no-due-date'}${task.dueTime ? `:t${task.dueTime}` : ''}${task.startTime ? `:s${task.startTime}` : ''}`;

export type SmartStartWindow = {
  task: Task;
  /** The exact deadline; null for a task with an explicit start time but no due time. */
  dueTime: number | null;
  /** When "start now" applies from. */
  latestStartTime: number;
  /** When the "work session soon" heads-up applies from. */
  notifyAtTime: number;
  /** When both reminders stop applying. */
  windowEndTime: number;
};

export const getTasksDueInNextHour = (tasks: Task[], nowTime = Date.now(), windowMinutes = 60) => {
  const upperBound = nowTime + windowMinutes * 60 * 1000;

  return tasks.filter((task) => {
    if (task.completed) {
      return false;
    }

    const dueTime = getDeadlineMs(task);
    if (dueTime === null) {
      return false;
    }

    return dueTime > nowTime && dueTime <= upperBound;
  });
};

export const getTasksOverdueNow = (tasks: Task[], nowTime = Date.now()) => {
  return tasks.filter((task) => {
    if (task.completed) {
      return false;
    }

    const dueTime = getDeadlineMs(task);
    if (dueTime === null) {
      return false;
    }

    return dueTime <= nowTime;
  });
};

/**
 * One start window per task, so a task never produces two sets of start reminders:
 *  - with an explicit start time (Issue #9) the window is built on it: the heads-up begins `bufferMinutes` before the
 *    start, "start now" begins at it and lasts until the exact deadline, or for `bufferMinutes` when there is no due
 *    time (so an old start time does not re-fire in every new session). It needs no time estimate.
 *  - without one, the established rule: it needs a time estimate and a future deadline, and the latest start is the
 *    deadline minus the estimate.
 */
export const getSmartStartWindows = (tasks: Task[], nowTime = Date.now(), bufferMinutes = 60): SmartStartWindow[] => {
  const bufferMs = bufferMinutes * 60 * 1000;
  const windows: SmartStartWindow[] = [];

  for (const task of tasks) {
    if (task.completed) {
      continue;
    }

    const explicitStart = getStartInstant(task.startTime);

    if (explicitStart !== null) {
      // Only an exact deadline can end the window. A date-only task's legacy deadline (UTC midnight of its day) is
      // usually already past on the day it is due, and would wrongly suppress every start reminder.
      const exactDeadline = getExactDeadline(task);
      const windowEndTime = exactDeadline ?? explicitStart + bufferMs;
      if (windowEndTime > nowTime) {
        windows.push({ task, dueTime: exactDeadline, latestStartTime: explicitStart, notifyAtTime: explicitStart - bufferMs, windowEndTime });
      }
      continue;
    }

    const dueTime = getDeadlineMs(task);

    if (!task.estimatedMinutes || task.estimatedMinutes <= 0 || dueTime === null || dueTime <= nowTime) {
      continue;
    }

    const latestStartTime = dueTime - task.estimatedMinutes * 60 * 1000;
    windows.push({ task, dueTime, latestStartTime, notifyAtTime: latestStartTime - bufferMs, windowEndTime: dueTime });
  }

  return windows;
};
