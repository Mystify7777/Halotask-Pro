import { NextFunction, Request, Response } from 'express';
import Task from '../models/Task.model';

const parseTaskBody = (body: Record<string, unknown>) => ({
  title: typeof body.title === 'string' ? body.title.trim() : undefined,
  description: typeof body.description === 'string' ? body.description.trim() : undefined,
  completed: typeof body.completed === 'boolean' ? body.completed : undefined,
  priority: typeof body.priority === 'string' ? body.priority : undefined,
  tags: Array.isArray(body.tags) ? body.tags.filter((tag): tag is string => typeof tag === 'string') : undefined,
  dueDate: body.dueDate ? new Date(String(body.dueDate)) : undefined,
  estimatedMinutes:
    typeof body.estimatedMinutes === 'number'
      ? body.estimatedMinutes
      : typeof body.estimatedMinutes === 'string'
        ? Number(body.estimatedMinutes)
        : undefined,
  reminderSent: typeof body.reminderSent === 'boolean' ? body.reminderSent : undefined,
});

export const getTasks = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tasks = await Task.find({ userId: req.user?.id }).sort({ createdAt: -1 });
    return res.json({ tasks });
  } catch (error) {
    return next(error);
  }
};

export const createTask = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = parseTaskBody(req.body as Record<string, unknown>);

    if (!payload.title) {
      return res.status(400).json({ message: 'title is required' });
    }

    const task = await Task.create({
      userId: req.user?.id,
      title: payload.title,
      description: payload.description ?? '',
      completed: payload.completed ?? false,
      priority: payload.priority ?? 'medium',
      tags: payload.tags ?? [],
      dueDate: payload.dueDate,
      estimatedMinutes: payload.estimatedMinutes ?? 0,
      reminderSent: payload.reminderSent ?? false,
    });

    return res.status(201).json({ task });
  } catch (error) {
    return next(error);
  }
};

export const updateTask = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const payload = parseTaskBody(req.body as Record<string, unknown>);
    const update = {
      ...(payload.title ? { title: payload.title } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.completed !== undefined ? { completed: payload.completed } : {}),
      ...(payload.priority ? { priority: payload.priority } : {}),
      ...(payload.tags ? { tags: payload.tags } : {}),
      ...(payload.dueDate ? { dueDate: payload.dueDate } : {}),
      ...(payload.estimatedMinutes !== undefined ? { estimatedMinutes: payload.estimatedMinutes } : {}),
      ...(payload.reminderSent !== undefined ? { reminderSent: payload.reminderSent } : {}),
    };

    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, userId: req.user?.id },
      update,
      { new: true },
    );

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    return res.json({ task });
  } catch (error) {
    return next(error);
  }
};

export const deleteTask = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const task = await Task.findOneAndDelete({ _id: req.params.id, userId: req.user?.id });

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    return res.json({ message: 'Task deleted' });
  } catch (error) {
    return next(error);
  }
};