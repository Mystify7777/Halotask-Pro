import { Task } from '../types/task';

const getStartOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

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

export const getOverdueTasks = (tasks: Task[]) => {
  const todayStart = getStartOfDay(new Date()).getTime();

  return tasks.filter((task) => {
    if (task.completed) {
      return false;
    }

    const dueDate = parseTaskDate(task.dueDate);
    if (!dueDate) {
      return false;
    }

    return getStartOfDay(dueDate).getTime() < todayStart;
  });
};

export const getDueTodayTasks = (tasks: Task[]) => {
  const todayKey = getDayKey(new Date());

  return tasks.filter((task) => {
    if (task.completed) {
      return false;
    }

    const dueDate = parseTaskDate(task.dueDate);
    if (!dueDate) {
      return false;
    }

    return getDayKey(dueDate) === todayKey;
  });
};

export const getUpcomingTasks = (tasks: Task[], limit = 5) => {
  const todayStart = getStartOfDay(new Date()).getTime();

  return tasks
    .filter((task) => {
      if (task.completed) {
        return false;
      }

      const dueDate = parseTaskDate(task.dueDate);
      if (!dueDate) {
        return false;
      }

      return getStartOfDay(dueDate).getTime() >= todayStart;
    })
    .sort((a, b) => {
      const dueA = parseTaskDate(a.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const dueB = parseTaskDate(b.dueDate)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      return dueA - dueB;
    })
    .slice(0, limit);
};

export const getCompletedToday = (tasks: Task[]) => {
  const todayKey = getDayKey(new Date());

  return tasks.filter((task) => {
    if (!task.completed) {
      return false;
    }

    const updatedDate = parseTaskDate(task.updatedAt);
    if (!updatedDate) {
      return false;
    }

    return getDayKey(updatedDate) === todayKey;
  });
};

export const getEstimatedWorkload = (tasks: Task[]) => {
  const relevantTasks = [...getOverdueTasks(tasks), ...getDueTodayTasks(tasks)];

  const uniqueById = new Map(relevantTasks.map((task) => [task._id, task]));

  return Array.from(uniqueById.values()).reduce((total, task) => total + Math.max(0, task.estimatedMinutes), 0);
};
