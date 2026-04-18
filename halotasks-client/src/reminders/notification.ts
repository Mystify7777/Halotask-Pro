import { Task } from '../types/task';

type ReminderNotificationType = 'due-soon' | 'overdue';

const buildTitle = (type: ReminderNotificationType) => {
  if (type === 'due-soon') {
    return 'Task due soon';
  }

  return 'Task overdue';
};

const buildBody = (task: Task, type: ReminderNotificationType) => {
  if (type === 'due-soon') {
    return `${task.title} is due within the next hour.`;
  }

  return `${task.title} is now overdue.`;
};

export const sendReminderNotification = (task: Task, type: ReminderNotificationType) => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return;
  }

  if (Notification.permission !== 'granted') {
    return;
  }

  const duePart = task.dueDate ?? 'no-due-date';

  new Notification(buildTitle(type), {
    body: buildBody(task, type),
    tag: `halotask-${type}-${task._id}-${duePart}`,
  });
};
