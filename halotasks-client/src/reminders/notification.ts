import { Task } from '../types/task';
import { getExactDeadline } from '../utils/deadline';
import { getEffectiveTimeZone } from '../utils/timeZone';
import { reminderSchedulePart } from './deadlineLogic';
import { reminderIdentity } from './identity';

type ReminderNotificationType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

export type ReminderNotificationPayload = {
  title: string;
  body: string;
  tag: string;
};

// A deadline's clock time in the user's effective time zone (Issue #41), never the device's: the same zone the
// deadline itself was read in.
const formatTime = (instant: number, timeZone: string = getEffectiveTimeZone()) =>
  new Date(instant).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    timeZone,
  });

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
    // A date-only task has no exact deadline to be "within the next hour" of: it is reminded on its due day (Issue #42).
    return getExactDeadline(task) === null
      ? `${task.title} is due today.`
      : `${task.title} is due within the next hour.`;
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
    // Name a deadline time only when the user supplied one. A date-only task has no deadline time, so it gets the
    // generic message.
    const exact = getExactDeadline(task);
    const dueAt = exact !== null ? formatTime(exact) : '';
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

/**
 * Shows the reminder. true when the browser was asked to show it; false when it could not be (no Notification API, or
 * permission not granted) so the caller can tell "delivered" from "silently dropped". A throwing Notification
 * constructor (some mobile browsers require a service worker) still throws.
 */
export const sendReminderNotification = (task: Task, type: ReminderNotificationType): boolean => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }

  if (Notification.permission !== 'granted') {
    return false;
  }

  const payload = getReminderPayload(task, type);

  new Notification(payload.title, {
    body: payload.body,
    tag: payload.tag,
  });
  return true;
};
