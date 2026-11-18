import type { Task } from '../types/task';
import { reminderIdentity } from './identity';

export type ReminderType = 'due-soon' | 'overdue' | 'work-session-soon' | 'start-now';

/**
 * The fixed order in which one task's simultaneous reminders are merged (Issue #14). The first type present leads the
 * notification (its title and sentence); the others follow as short clauses in this same order. It is a constant, not
 * derived from the order the tasks or events were visited in, so the same task and the same set of types always
 * produce the same notification.
 *
 * `overdue` is last only for completeness: an overdue task has passed its deadline, which is where every start window
 * and the due-soon window end, so it never co-occurs with the others.
 */
export const REMINDER_PRECEDENCE: readonly ReminderType[] = ['start-now', 'due-soon', 'work-session-soon', 'overdue'];

/** `types` without repeats, in REMINDER_PRECEDENCE order. */
export const orderReminderTypes = (types: readonly ReminderType[]): ReminderType[] =>
  REMINDER_PRECEDENCE.filter((type) => types.includes(type));

export type TimedReminderEvent = { task: Task; type: ReminderType };

/** One notification for one task: `type` leads, `merged` is every type it stands for (lead first). */
export type ReminderGroup = { task: Task; type: ReminderType; merged: ReminderType[] };

/**
 * Merges the events of ONE poll that belong to the same task (same reminder identity) into one group per task. Events
 * of different tasks are never merged. Groups come out in the order their task first appears in `events`; inside a group
 * the types follow REMINDER_PRECEDENCE, so nothing depends on the order of the events of a single task.
 */
export const groupTimedEvents = (events: readonly TimedReminderEvent[]): ReminderGroup[] => {
  const byTask = new Map<string, { task: Task; types: ReminderType[] }>();
  for (const { task, type } of events) {
    const identity = reminderIdentity(task);
    const entry = byTask.get(identity);
    if (entry) {
      entry.types.push(type);
    } else {
      byTask.set(identity, { task, types: [type] });
    }
  }
  return [...byTask.values()].map(({ task, types }) => {
    const merged = orderReminderTypes(types);
    return { task, type: merged[0], merged };
  });
};
