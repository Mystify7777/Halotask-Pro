import { Task } from '../types/task';

type ReminderNotificationType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

const formatTime = (value?: string) => {
  if (!value) {
    return '';
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '';
  }

  return parsed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
  });
};

const buildTitle = (type: ReminderNotificationType) => {
  if (type === 'due-soon') {
    return 'Task due soon';
  }

  if (type === 'work-session-soon') {
    return 'Planned work session should begin soon';
  }

  if (type === 'start-now') {
    return 'Start now to finish on time';
  }

  return 'Task overdue';
};

const buildBody = (task: Task, type: ReminderNotificationType) => {
  if (type === 'due-soon') {
    return `${task.title} is due within the next hour.`;
  }

  if (type === 'work-session-soon') {
    const hours = task.estimatedMinutes > 0 ? Math.ceil(task.estimatedMinutes / 60) : 0;
    const durationText = hours > 0 ? `${hours}h` : `${task.estimatedMinutes}m`;
    return `You planned ${durationText} for ${task.title}. Consider starting soon.`;
  }

  if (type === 'start-now') {
    const dueAt = formatTime(task.dueDate);
    return dueAt
      ? `Start ${task.title} now to stay on track for ${dueAt}.`
      : `Start ${task.title} now to stay on track.`;
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
