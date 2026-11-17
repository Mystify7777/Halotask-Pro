import Task from '../models/Task.model';
import User from '../models/User.model';
import type { EngineTask } from '../utils/emailReminderEngine';
import type { RunUser } from './emailReminderRun';

/**
 * The database side of a reminder run (Issue #29): who has opted in and what tasks they have. Read-only. Mongoose only;
 * everything about WHEN lives in the pure engine.
 */

/** The most tasks read per account in one run. A reminder-bearing task is one with a due date or a start time. */
export const RUN_TASK_LIMIT = 500;

export async function* optedInUsers(): AsyncIterable<RunUser> {
  const cursor = User.find({ 'emailReminders.enabled': true }).select('email timeZone emailReminders').sort({ _id: 1 }).lean().cursor();
  for await (const user of cursor) {
    yield { id: String(user._id), email: user.email, timeZone: user.timeZone ?? null, emailReminders: user.emailReminders };
  }
}

export const tasksForUser = async (userId: string): Promise<EngineTask[]> => {
  const tasks = await Task.find({ userId, completed: false, $or: [{ dueDate: { $ne: null } }, { startTime: { $ne: null } }] })
    .select('title completed priority dueDate dueTime startTime estimatedMinutes')
    .sort({ _id: 1 })
    .limit(RUN_TASK_LIMIT)
    .lean();

  return tasks.map((task) => ({
    id: String(task._id),
    title: task.title,
    completed: task.completed,
    priority: task.priority,
    dueDate: task.dueDate ?? null,
    dueTime: task.dueTime ?? null,
    startTime: task.startTime ?? null,
    estimatedMinutes: task.estimatedMinutes ?? null,
  }));
};
