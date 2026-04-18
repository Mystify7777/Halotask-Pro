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

export type SmartStartWindow = {
  task: Task;
  dueTime: number;
  latestStartTime: number;
  notifyAtTime: number;
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

export const getSmartStartWindows = (tasks: Task[], nowTime = Date.now(), bufferMinutes = 60): SmartStartWindow[] => {
  const bufferMs = bufferMinutes * 60 * 1000;

  return tasks
    .filter((task) => {
      if (task.completed) {
        return false;
      }

      if (!task.estimatedMinutes || task.estimatedMinutes <= 0) {
        return false;
      }

      const dueTime = parseDueTime(task.dueDate);
      if (dueTime === null) {
        return false;
      }

      return dueTime > nowTime;
    })
    .map((task) => {
      const dueTime = parseDueTime(task.dueDate) ?? nowTime;
      const latestStartTime = dueTime - task.estimatedMinutes * 60 * 1000;
      const notifyAtTime = latestStartTime - bufferMs;

      return {
        task,
        dueTime,
        latestStartTime,
        notifyAtTime,
      };
    });
};
