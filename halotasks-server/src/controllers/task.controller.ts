import { NextFunction, Response } from 'express';
import Task from '../models/Task.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { parsePagination } from '../utils/pagination';
import { createTaskService, deleteTaskService, updateTaskService, type ServiceResult } from '../services/taskMutations';
import { executeTaskSync } from '../services/taskSync';

// The create / update / delete rules live in services/taskMutations.ts (Issue #60) so the batch sync endpoint runs the very
// same code. These handlers only translate between HTTP and a service call; the answers are unchanged.

const send = async (res: Response, next: NextFunction, run: () => Promise<ServiceResult>) => {
  try {
    const result = await run();
    return res.status(result.status).json(result.body);
  } catch (error) {
    return next(error);
  }
};

export const getTasks = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const pagination = parsePagination(req.query as Record<string, unknown>);
    if (!pagination.ok) {
      return res.status(400).json({ message: pagination.message });
    }
    const { page, limit, skip } = pagination.value;

    const filter = { userId: req.user.id };

    const [tasks, total] = await Promise.all([
      Task.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit),
      Task.countDocuments(filter),
    ]);

    // `page`/`limit`/`total`/`hasMore` are additive — a client that only
    // destructures `{ tasks }` (the pre-pagination contract) is unaffected.
    return res.json({
      tasks,
      page,
      limit,
      total,
      hasMore: skip + tasks.length < total,
    });
  } catch (error) {
    return next(error);
  }
};

export const createTask = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  send(res, next, () => createTaskService(req.user.id, req.body));

export const updateTask = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  send(res, next, () => updateTaskService(req.user.id, req.params.id, req.body));

export const deleteTask = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  send(res, next, () => deleteTaskService(req.user.id, req.params.id));

export const syncTasks = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  send(res, next, () => executeTaskSync(req.user.id, req.body));
