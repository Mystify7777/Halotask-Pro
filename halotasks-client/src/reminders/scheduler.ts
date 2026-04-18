import { Task } from '../types/task';
import { getTasksDueInNextHour, getTasksOverdueNow } from './deadlineLogic';

type ReminderType = 'due-soon' | 'overdue';

type ReminderEvent = {
  task: Task;
  type: ReminderType;
};

type ReminderSchedulerOptions = {
  getTasks: () => Task[];
  onReminder: (event: ReminderEvent) => void;
  intervalMs?: number;
};

export const createReminderScheduler = ({
  getTasks,
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
    const nowTime = Date.now();

    const dueSoon = getTasksDueInNextHour(tasks, nowTime, 60);
    const overdue = getTasksOverdueNow(tasks, nowTime);

    dueSoon.forEach((task) => dispatchIfNeeded(task, 'due-soon'));
    overdue.forEach((task) => dispatchIfNeeded(task, 'overdue'));
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
