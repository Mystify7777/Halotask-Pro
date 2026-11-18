import { Task } from '../types/task';
import { getExactDeadline } from '../utils/deadline';
import { getEffectiveTimeZone } from '../utils/timeZone';
import { reminderSchedulePart } from './deadlineLogic';
import { orderReminderTypes, type ReminderType } from './grouping';
import { reminderIdentity } from './identity';

type ReminderNotificationType = ReminderType;

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

/** What a merged reminder adds after the lead sentence, one fixed clause per type (Issue #14). */
const MERGED_CLAUSE: Record<ReminderNotificationType, string> = {
  'start-now': 'Time to start.',
  'due-soon': 'Due within the next hour.',
  'work-session-soon': 'A planned work session starts soon.',
  overdue: 'It is now overdue.',
};

/**
 * The notification for one task's timed reminders of one poll (Issue #14). `types` are the reminders it stands for;
 * the lead is the first in REMINDER_PRECEDENCE, whose title and sentence (the ones a single reminder has always had)
 * come first, followed by one fixed clause per other type, in that order. The result depends only on the task, the lead
 * and the set of types, never on the order anything was visited in.
 *
 * The tag is the task's stable reminder identity, not its title and not its schedule: all of a task's timed
 * notifications share it, so a later one replaces the earlier one in the tray (the sender asks to be re-announced, see
 * `renotify`). Date-only calendar-day reminders (Issue #42) do NOT use this; they keep `getReminderPayload`.
 */
export const getTimedReminderPayload = (task: Task, types: readonly ReminderNotificationType[]): ReminderNotificationPayload => {
  const ordered = orderReminderTypes(types);
  const [lead, ...rest] = ordered;
  if (lead === undefined) {
    throw new Error('A timed reminder needs at least one type.');
  }
  return {
    title: buildTitle(lead),
    body: [buildBody(task, lead), ...rest.map((type) => MERGED_CLAUSE[type])].join(' '),
    tag: `halotask-task-${reminderIdentity(task)}`,
  };
};

/** The payload for one reminder event: the merged task notification when `merged` is given, else the per-type one. */
export const reminderPayloadFor = (
  task: Task,
  type: ReminderNotificationType,
  merged?: readonly ReminderNotificationType[],
): ReminderNotificationPayload => (merged ? getTimedReminderPayload(task, merged) : getReminderPayload(task, type));

/**
 * Shows the reminder. true when the browser was asked to show it; false when it could not be (no Notification API, or
 * permission not granted) so the caller can tell "delivered" from "silently dropped". A throwing Notification
 * constructor (some mobile browsers require a service worker) still throws.
 */
export const sendReminderNotification = (
  task: Task,
  type: ReminderNotificationType,
  merged?: readonly ReminderNotificationType[],
): boolean => {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }

  if (Notification.permission !== 'granted') {
    return false;
  }

  const payload = reminderPayloadFor(task, type, merged);

  // A merged task notification reuses one tag per task, so a later one replaces the earlier one in the tray; renotify
  // makes that replacement alert again (a tag alone would swap it silently). The service worker does the same for the
  // relayed copy (public/sw.js). Calendar-day reminders keep their own per-type tag and no renotify.
  const options: NotificationOptions & { renotify?: boolean } = { body: payload.body, tag: payload.tag };
  if (merged) {
    options.renotify = true;
  }
  new Notification(payload.title, options);
  return true;
};
