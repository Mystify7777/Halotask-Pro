import { Task } from '../types/task';
import { dueDayKey, getExactDeadline, getStartInstant } from '../utils/deadline';
import { dateKeyInZone, dateKeyOffsetInZone, getEffectiveTimeZone } from '../utils/timeZone';

/**
 * The moment reminders treat as a task's deadline: the exact local time when the task has a due time. A date-only task
 * has NO deadline instant (Issue #42): it is due "sometime that day", so it is never read as UTC midnight, never given
 * a local midnight or an end-of-day instant, and is reminded by calendar day instead (`getDateOnlyReminderPhase`).
 * null when the task has no due date or no due time.
 */
export const getDeadlineMs = (task: Task): number | null => getExactDeadline(task);

/**
 * Where a date-only task is in its calendar-day reminder window, judged in the effective time zone (Issue #42):
 *  - 'due-today': today (in the zone) is the due day.
 *  - 'overdue':   today is the day AFTER the due day, i.e. the due day has just ended. It matches `getDueState`.
 *  - null:        any other day, a completed task, a task with an exact deadline, or no usable due date.
 * The window is deliberately two days wide, so a reminder is never replayed for a day that is long gone (the card
 * itself stays overdue; only the notification is limited to the first day).
 */
export type DateOnlyReminderPhase = 'due-today' | 'overdue';

export const getDateOnlyReminderPhase = (
  task: Task,
  nowTime: number = Date.now(),
  timeZone: string = getEffectiveTimeZone(),
): DateOnlyReminderPhase | null => {
  if (task.completed || getExactDeadline(task, timeZone) !== null) {
    return null;
  }

  const day = dueDayKey(task.dueDate);
  if (day === null) {
    return null;
  }

  if (day === dateKeyInZone(nowTime, timeZone)) {
    return 'due-today';
  }

  return day === dateKeyOffsetInZone(-1, nowTime, timeZone) ? 'overdue' : null;
};

export const getDateOnlyTasksInPhase = (
  tasks: Task[],
  phase: DateOnlyReminderPhase,
  nowTime: number = Date.now(),
  timeZone: string = getEffectiveTimeZone(),
) => tasks.filter((task) => getDateOnlyReminderPhase(task, nowTime, timeZone) === phase);

/**
 * What identifies a task's schedule for reminder de-duplication (the in-session key and the notification tag). A task
 * that has no due time and no start time yields exactly what it always did (its due date, or 'no-due-date'), so
 * nothing already de-duplicated is re-sent. Changing a time is a new schedule and re-arms the reminder; a retry, a
 * sync, or an edit of any other field leaves it unchanged and sends nothing twice. A due time is a wall-clock reading, so
 * the zone it is read in is part of the schedule (Issue #41): changing the time zone moves the deadline instant and so
 * re-arms the reminder. A start time is an instant and a date-only task has no clock, so neither carries the zone.
 */
export const reminderSchedulePart = (task: Task): string =>
  `${task.dueDate ?? 'no-due-date'}${task.dueTime ? `:t${task.dueTime}@${getEffectiveTimeZone()}` : ''}${task.startTime ? `:s${task.startTime}` : ''}`;

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
      // Only an exact deadline can end the window: a date-only task has none.
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
