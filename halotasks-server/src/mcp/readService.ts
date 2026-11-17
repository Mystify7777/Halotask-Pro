import mongoose from 'mongoose';
import Task from '../models/Task.model';

export type TaskReadFilter = {
  completed?: boolean;
  priority?: 'low' | 'medium' | 'high';
  tag?: string;
  search?: string;
};

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&');
const MAX_SUMMARY_TASKS = 10_000;

const escapeRegex = (value: string): string => value.replace(/[.*+?^$\\{}()|[\\]\\]/g, '\\$&');

const taskProjection = {
  _id: 1,
  title: 1,
  description: 1,
  completed: 1,
  priority: 1,
  tags: 1,
  subtasks: 1,
  dueDate: 1,
  dueTime: 1,
  startTime: 1,
  estimatedMinutes: 1,
  reminderSent: 1,
  completedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

const baseFilter = (userId: string): Record<string, unknown> => {
  if (!mongoose.Types.ObjectId.isValid(userId)) {
    throw new Error('Invalid authenticated user id');
  }
  return { userId };
};

const buildFilter = (userId: string, filter: TaskReadFilter = {}) => {
  const query: Record<string, unknown> = baseFilter(userId);

  if (filter.completed !== undefined) query.completed = filter.completed;
  if (filter.priority !== undefined) query.priority = filter.priority;
  if (filter.tag !== undefined && filter.tag.trim() !== '') {
    query.tags = filter.tag.trim();
  }
  if (filter.search !== undefined && filter.search.trim() !== '') {
    const pattern = escapeRegex(filter.search.trim());
    query.$or = [
      { title: { $regex: pattern, $options: 'i' } },
      { description: { $regex: pattern, $options: 'i' } },
      { tags: { $regex: pattern, $options: 'i' } },
    ];
  }

  return query;
};

export const listTasksForUser = async (
  userId: string,
  options: TaskReadFilter & { page?: number; limit?: number } = {},
) => {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, options.limit ?? 20));
  const skip = (page - 1) * limit;
  const filter = buildFilter(userId, options);

  const [tasks, total] = await Promise.all([
    Task.find(filter).select(taskProjection).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
    Task.countDocuments(filter),
  ]);

  return {
    tasks,
    page,
    limit,
    total,
    hasMore: skip + tasks.length < total,
  };
};

export const getTaskForUser = async (userId: string, taskId: string) => {
  if (!mongoose.Types.ObjectId.isValid(taskId)) return null;
  return Task.findOne({ _id: taskId, userId: baseFilter(userId).userId }).select(taskProjection).lean();
};

export const listSubtasksForUser = async (userId: string, taskId: string) => {
  const task = await getTaskForUser(userId, taskId);
  if (!task) return null;

  return {
    taskId: String(task._id),
    taskTitle: task.title,
    subtasks: task.subtasks ?? [],
  };
};

export const getProjectContextForUser = async (userId: string) => {
  const filter = baseFilter(userId);
  const [totalTasks, completedTasks, priorities, tags] = await Promise.all([
    Task.countDocuments(filter),
    Task.countDocuments({ ...filter, completed: true }),
    Task.aggregate<{ _id: string; count: number }>([
      { $match: filter },
      { $group: { _id: '$priority', count: { $sum: 1 } } },
    ]),
    Task.aggregate<{ _id: string; count: number }>([
      { $match: filter },
      { $unwind: '$tags' },
      { $group: { _id: '$tags', count: { $sum: 1 } } },
      { $sort: { count: -1, _id: 1 } },
      { $limit: 50 },
    ]),
  ]);

  return {
    workspace: 'HaloTask',
    projectModel: 'No first-class project entity exists in the current data model.',
    userId,
    capabilities: {
      tasks: true,
      subtasks: true,
      projectMetadata: false,
      dependencies: false,
      comments: false,
      writes: false,
    },
    taskCounts: {
      total: totalTasks,
      completed: completedTasks,
      open: totalTasks - completedTasks,
    },
    priorities: Object.fromEntries(priorities.map((entry) => [entry._id, entry.count])),
    tags: tags.map((entry) => ({ tag: entry._id, count: entry.count })),
  };
};

export const getProjectSummaryForUser = async (userId: string) => {
  const filter = baseFilter(userId);
  const now = new Date();

  const [counts, due, overdue, recent] = await Promise.all([
    Task.aggregate<{ _id: boolean; count: number }>([
      { $match: filter },
      { $group: { _id: '$completed', count: { $sum: 1 } } },
    ]),
    Task.countDocuments({
      ...filter,
      completed: false,
      dueDate: { $gte: now },
    }),
    Task.countDocuments({
      ...filter,
      completed: false,
      dueDate: { $lt: now },
    }),
    Task.find(filter).sort({ updatedAt: -1 }).limit(5).select('_id title completed priority dueDate updatedAt').lean(),
  ]);

  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const completed = counts.find((entry) => entry._id === true)?.count ?? 0;

  return {
    totalTasks: total,
    completedTasks: completed,
    openTasks: total - completed,
    upcomingDueTasks: due,
    overdueOpenTasks: overdue,
    recentTasks: recent.map((task) => ({
      id: String(task._id),
      title: task.title,
      completed: task.completed,
      priority: task.priority,
      dueDate: task.dueDate?.toISOString() ?? null,
      updatedAt: task.updatedAt?.toISOString() ?? null,
    })),
    taskCap: MAX_SUMMARY_TASKS,
  };
};
