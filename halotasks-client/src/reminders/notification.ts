import { Task } from '../types/task';
import { getExactDeadline } from '../utils/deadline';
import { reminderSchedulePart } from './deadlineLogic';
import { reminderIdentity } from './identity';

type ReminderNotificationType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

export type ReminderNotificationPayload = {
  title: string;
  body: string;
  tag: string;
};

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
    // An explicit start time needs no estimate, so there may be no planned duration to mention.
    if (!(task.estimatedMinutes > 0)) {
      return `${task.title} is planned to start soon.`;
    }
    const hours = task.estimatedMinutes > 0 ? Math.ceil(task.estimatedMinutes / 60) : 0;
    const durationText = hours > 0 ? `${hours}h` : `${task.estimatedMinutes}m`;
    return `You planned ${durationText} for ${task.title}. Consider starting soon.`;
  }

  if (type === 'start-now') {
    // Name a deadline time only when the user supplied one. A date-only task's stored dueDate is UTC midnight, which
    // is not a time anyone chose, so it gets the generic message.
    const exact = getExactDeadline(task);
    const dueAt = exact !== null ? formatTime(new Date(exact).toISOString()) : '';
    return dueAt
      ? `Start ${task.title} now to stay on track for ${dueAt}.`
      : `Start ${task.title} now to stay on track.`;
  }

  return `${task.title} is now overdue.`;
};

export const getReminderPayload = (task: Task, type: ReminderNotificationType): ReminderNotificationPayload => {
  return {
    title: buildTitle(type),
    body: buildBody(task, type),
    tag: `halotask-${type}-${reminderIdentity(task)}-${reminderSchedulePart(task)}`,
  };
};

export const sendReminderNotification = (task: Task, type: ReminderNotificationType) => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return;
  }

  if (Notification.permission !== 'granted') {
    return;
  }

  const payload = getReminderPayload(task, type);

  new Notification(payload.title, {
    body: payload.body,
    tag: payload.tag,
  });
};
