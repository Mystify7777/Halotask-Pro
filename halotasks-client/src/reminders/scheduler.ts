import { Task } from '../types/task';
import { getSmartStartWindows, getTasksDueInNextHour, getTasksOverdueNow } from './deadlineLogic';
import { isWithinQuietHours, ReminderSettings } from './settings';

type ReminderType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

type ReminderEvent = {
  task: Task;
  type: ReminderType;
};

type ReminderSchedulerOptions = {
  getTasks: () => Task[];
  getSettings: () => ReminderSettings;
  onReminder: (event: ReminderEvent) => void;
  intervalMs?: number;
};

export const createReminderScheduler = ({
  getTasks,
  getSettings,
  onReminder,
  intervalMs = 60_000,
}: ReminderSchedulerOptions) => {
  let timer: number | null = null;
  const notifiedInSession = new Set<string>();

  const makeKey = (task: Task, type: ReminderType) => {
    const duePart = task.dueDate ?? 'no-due-date';
    return `${type}:${task._id}:${duePart}`;
  };

  const dispatchIfNeeded = (task: Task, type: ReminderType) => {
    const key = makeKey(task, type);
    if (notifiedInSession.has(key)) {
      return;
    }

    notifiedInSession.add(key);
    onReminder({ task, type });
  };

  const runNow = () => {
    const tasks = getTasks();
    const settings = getSettings();
    const nowTime = Date.now();

    if (!settings.enabled) {
      return;
    }

    if (isWithinQuietHours(new Date(nowTime), settings)) {
      return;
    }

    const dueSoon = settings.dueSoonEnabled ? getTasksDueInNextHour(tasks, nowTime, 60) : [];
    const overdue = getTasksOverdueNow(tasks, nowTime);
    const smartStartWindows = getSmartStartWindows(tasks, nowTime, settings.bufferMinutes);

    dueSoon.forEach((task) => dispatchIfNeeded(task, 'due-soon'));
    if (settings.overdueEnabled) {
      overdue.forEach((task) => dispatchIfNeeded(task, 'overdue'));
    }

    smartStartWindows.forEach(({ task, dueTime, latestStartTime, notifyAtTime }) => {
      if (settings.workSessionSoonEnabled && nowTime >= notifyAtTime && nowTime < latestStartTime) {
        dispatchIfNeeded(task, 'work-session-soon');
      }

      if (settings.startNowEnabled && nowTime >= latestStartTime && nowTime < dueTime) {
        dispatchIfNeeded(task, 'start-now');
      }
    });
  };

  const start = () => {
    if (timer !== null) {
      return;
    }

    runNow();
    timer = window.setInterval(runNow, intervalMs);
  };

  const stop = () => {
    if (timer === null) {
      return;
    }

    window.clearInterval(timer);
    timer = null;
  };

  const resetSession = () => {
    notifiedInSession.clear();
  };

  return {
    start,
    stop,
    runNow,
    resetSession,
  };
};
