import mongoose from 'mongoose';
import Task from '../models/Task.model';
import User from '../models/User.model';
import { dueDayKey, exactDeadline } from '../utils/emailReminderEngine';
import type { McpScope } from './scope';

// Read-only task access for the MCP tools (Issue #66, Phase 1). Every function takes the McpScope the route built from the
// AUTHENTICATED identity and puts the owner into the query itself; there is no path that reads by id alone. The select
// projections below are an allow-list: a field reaches the AI client only if it is named here, so internal fields
// (userId, completionId, appliedMutations, clientKey, reminderSent, ...) can never leak by being added to the model later.

export type TaskReadFilter = {
  completed?: boolean;
  priority?: 'low' | 'medium' | 'high';
  tag?: string;
  search?: string;
};

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 20;
const MAX_SUMMARY_TASKS = 5;
const MAX_TAGS = 50;
/** Bound on the tasks due TODAY that are read to tell a passed timed deadline from a pending one. */
const MAX_TODAY_TASKS = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

type TaskFilterDocument = {
  userId: mongoose.Types.ObjectId;
  title: string;
  description: string;
  completed: boolean;
  priority: 'low' | 'medium' | 'high';
  tags: string[];
  dueDate?: Date;
  updatedAt?: Date;
};

type TaskFilter = mongoose.QueryFilter<TaskFilterDocument>;

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
  completedAt: 1,
  createdAt: 1,
  updatedAt: 1,
};

const ownerOf = (scope: McpScope): mongoose.Types.ObjectId => {
  if (scope.kind !== 'personal' || !mongoose.Types.ObjectId.isValid(scope.userId)) {
    throw new Error('Invalid MCP scope');
  }
  return new mongoose.Types.ObjectId(scope.userId);
};

const baseFilter = (scope: McpScope): TaskFilter => ({ userId: ownerOf(scope) });

const buildFilter = (scope: McpScope, filter: TaskReadFilter = {}): TaskFilter => {
  const query: TaskFilter = baseFilter(scope);

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

export const listTasksForUser = async (scope: McpScope, options: TaskReadFilter & { page?: number; limit?: number } = {}) => {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(MAX_PAGE_SIZE, Math.max(1, options.limit ?? DEFAULT_PAGE_SIZE));
  const skip = (page - 1) * limit;
  const filter = buildFilter(scope, options);

  const [tasks, total] = await Promise.all([
    // `_id` breaks createdAt ties so a page boundary never repeats or skips a task.
    Task.find(filter).select(taskProjection).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
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

export const getTaskForUser = async (scope: McpScope, taskId: string) => {
  const owner = ownerOf(scope);
  if (!mongoose.Types.ObjectId.isValid(taskId)) return null;
  return Task.findOne({ _id: taskId, userId: owner }).select(taskProjection).lean();
};

export const listSubtasksForUser = async (scope: McpScope, taskId: string) => {
  const task = await getTaskForUser(scope, taskId);
  if (!task) return null;

  return {
    taskId: String(task._id),
    taskTitle: task.title,
    subtasks: task.subtasks ?? [],
  };
};

export const getProjectContextForUser = async (scope: McpScope) => {
  const filter = baseFilter(scope);
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
      { $limit: MAX_TAGS },
    ]),
  ]);

  return {
    workspace: 'HaloTask',
    projectModel: 'No first-class project entity exists in the current data model.',
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
    tagCap: MAX_TAGS,
  };
};

/** The calendar day (YYYY-MM-DD) of `now` in `timeZone`. */
const localDayKey = (now: Date, timeZone: string): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
};

const zoneOf = (stored: unknown): string => {
  if (typeof stored !== 'string' || stored === '') return 'UTC';
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: stored });
    return stored;
  } catch {
    return 'UTC';
  }
};

/**
 * Due dates are CALENDAR DAYS (Issues #41/#42): a stored `dueDate` names its UTC date part, and `dueTime` is a wall-clock time
 * in the user's zone. So "overdue" is judged by day in the user's zone, and a timed task due today is overdue only once its
 * exact deadline has passed. (Comparing `dueDate < now` as instants, as the first draft did, calls every date-only task due
 * today overdue from the start of the day.) The zone is the account's `timeZone`; an account without one is read as UTC.
 */
export const getProjectSummaryForUser = async (scope: McpScope, now: Date = new Date()) => {
  const filter = baseFilter(scope);
  const owner = await User.findById(filter.userId).select('timeZone').lean();
  const timeZone = zoneOf(owner?.timeZone);
  const today = localDayKey(now, timeZone);
  const todayStart = new Date(`${today}T00:00:00.000Z`);
  const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);

  const [counts, overdueByDay, upcomingByDay, dueToday, recent] = await Promise.all([
    Task.aggregate<{ _id: boolean; count: number }>([
      { $match: filter },
      { $group: { _id: '$completed', count: { $sum: 1 } } },
    ]),
    Task.countDocuments({ ...filter, completed: false, dueDate: { $lt: todayStart } }),
    Task.countDocuments({ ...filter, completed: false, dueDate: { $gte: tomorrowStart } }),
    Task.find({ ...filter, completed: false, dueDate: { $gte: todayStart, $lt: tomorrowStart } })
      .select('dueDate dueTime')
      .limit(MAX_TODAY_TASKS)
      .lean(),
    Task.find(filter).sort({ updatedAt: -1, _id: -1 }).limit(MAX_SUMMARY_TASKS).select('_id title completed priority dueDate updatedAt').lean(),
  ]);

  let overdueToday = 0;
  let pendingToday = 0;
  for (const task of dueToday) {
    const deadline = exactDeadline({ dueDate: task.dueDate, dueTime: task.dueTime }, timeZone);
    if (deadline !== null && deadline < now.getTime()) overdueToday += 1;
    else pendingToday += 1;
  }

  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  const completed = counts.find((entry) => entry._id === true)?.count ?? 0;

  return {
    asOf: now.toISOString(),
    timeZone,
    today,
    totalTasks: total,
    completedTasks: completed,
    openTasks: total - completed,
    overdueOpenTasks: overdueByDay + overdueToday,
    dueTodayOpenTasks: pendingToday,
    upcomingDueTasks: upcomingByDay,
    recentTasks: recent.map((task) => ({
      id: String(task._id),
      title: task.title,
      completed: task.completed,
      priority: task.priority,
      dueDay: dueDayKey(task.dueDate),
      updatedAt: task.updatedAt?.toISOString() ?? null,
    })),
    recentTaskCap: MAX_SUMMARY_TASKS,
  };
};
