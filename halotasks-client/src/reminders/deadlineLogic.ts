import { Task } from '../types/task';

const parseDueTime = (dueDate?: string) => {
  if (!dueDate) {
    return null;
  }

  const parsed = new Date(dueDate);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed.getTime();
};

export const getTasksDueInNextHour = (tasks: Task[], nowTime = Date.now(), windowMinutes = 60) => {
  const upperBound = nowTime + windowMinutes * 60 * 1000;

  return tasks.filter((task) => {
    if (task.completed) {
      return false;
    }

    const dueTime = parseDueTime(task.dueDate);
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

    const dueTime = parseDueTime(task.dueDate);
    if (dueTime === null) {
      return false;
    }

    return dueTime <= nowTime;
  });
};
