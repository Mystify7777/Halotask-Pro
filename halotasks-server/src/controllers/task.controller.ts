import { NextFunction, Response } from 'express';
import mongoose from 'mongoose';
import Task from '../models/Task.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { BODY_MUST_BE_OBJECT, isPlainObject } from '../utils/requestBody';
import { parsePagination } from '../utils/pagination';
import {
  DESCRIPTION_MAX_LENGTH,
  TAGS_MAX_COUNT,
  TAG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  isNonEmptyTitle,
  isValidEstimatedMinutes,
  isValidPriority,
  parseDueDate,
} from '../utils/taskValidators';

const isValidObjectId = (id: unknown): boolean => typeof id === 'string' && mongoose.Types.ObjectId.isValid(id);

// Translates an unexpected Mongoose validation/cast error into a clean 400
// instead of letting it fall through to the generic 500 handler — a safety
// net for anything the explicit checks above didn't anticipate. Returns
// false (and does nothing) for errors that aren't input-shaped, so callers
// can fall through to next(error) for genuine server errors.
const respondIfMongooseInputError = (error: unknown, res: Response): boolean => {
  if (error instanceof mongoose.Error.ValidationError || error instanceof mongoose.Error.CastError) {
    console.error('[Tasks] Rejected malformed task data:', error);
    res.status(400).json({ message: 'Invalid task data' });
    return true;
  }
  return false;
};

type ParsedTaskBody = {
  title?: string;
  description?: string;
  completed?: boolean;
  priority?: string;
  tags?: string[];
  dueDate?: Date;
  estimatedMinutes?: number;
  reminderSent?: boolean;
};

type ParseResult = { ok: true; value: ParsedTaskBody } | { ok: false; message: string };

/**
 * Parses and validates the task request body shared by create/update.
 * `requireTitle` controls whether an absent title is an error (create) or
 * simply "no change" (update) — but a title that's present and invalid
 * (wrong type, too long, empty/whitespace) is always rejected, on both
 * paths, so empty titles can't slip through depending on which endpoint is
 * called.
 */
const parseTaskBody = (
  body: Record<string, unknown>,
  { requireTitle }: { requireTitle: boolean },
): ParseResult => {
  const result: ParsedTaskBody = {};

  if (body.title !== undefined) {
    if (typeof body.title !== 'string' || !isNonEmptyTitle(body.title)) {
      return { ok: false, message: 'title must be a non-empty string' };
    }
    const trimmed = body.title.trim();
    if (trimmed.length > TITLE_MAX_LENGTH) {
      return { ok: false, message: `title must be at most ${TITLE_MAX_LENGTH} characters` };
    }
    result.title = trimmed;
  } else if (requireTitle) {
    return { ok: false, message: 'title is required' };
  }

  if (body.description !== undefined) {
    if (typeof body.description !== 'string') {
      return { ok: false, message: 'description must be a string' };
    }
    const trimmed = body.description.trim();
    if (trimmed.length > DESCRIPTION_MAX_LENGTH) {
      return { ok: false, message: `description must be at most ${DESCRIPTION_MAX_LENGTH} characters` };
    }
    result.description = trimmed;
  }

  if (body.completed !== undefined) {
    if (typeof body.completed !== 'boolean') {
      return { ok: false, message: 'completed must be a boolean' };
    }
    result.completed = body.completed;
  }

  if (body.priority !== undefined) {
    if (!isValidPriority(body.priority)) {
      return { ok: false, message: "priority must be one of 'low', 'medium', or 'high'" };
    }
    result.priority = body.priority;
  }

  if (body.tags !== undefined) {
    if (!Array.isArray(body.tags) || !body.tags.every((tag): tag is string => typeof tag === 'string')) {
      return { ok: false, message: 'tags must be an array of strings' };
    }
    if (body.tags.length > TAGS_MAX_COUNT) {
      return { ok: false, message: `tags cannot have more than ${TAGS_MAX_COUNT} entries` };
    }
    const trimmedTags = body.tags.map((tag) => tag.trim());
    if (trimmedTags.some((tag) => tag.length > TAG_MAX_LENGTH)) {
      return { ok: false, message: `each tag must be at most ${TAG_MAX_LENGTH} characters` };
    }
    result.tags = trimmedTags;
  }

  if (body.dueDate !== undefined) {
    const parsedDueDate = parseDueDate(body.dueDate);
    if (!parsedDueDate.ok) {
      return { ok: false, message: 'dueDate must be a valid date' };
    }
    if (parsedDueDate.value !== undefined) {
      result.dueDate = parsedDueDate.value;
    }
  }

  if (body.estimatedMinutes !== undefined) {
    if (typeof body.estimatedMinutes !== 'number' && typeof body.estimatedMinutes !== 'string') {
      return { ok: false, message: 'estimatedMinutes must be a number' };
    }
    if (typeof body.estimatedMinutes === 'string' && body.estimatedMinutes.trim() === '') {
      return { ok: false, message: 'estimatedMinutes must be a number' };
    }
    const numericValue = Number(body.estimatedMinutes);
    if (!isValidEstimatedMinutes(numericValue)) {
      return { ok: false, message: 'estimatedMinutes must be a non-negative number within a reasonable range' };
    }
    result.estimatedMinutes = numericValue;
  }

  if (body.reminderSent !== undefined) {
    if (typeof body.reminderSent !== 'boolean') {
      return { ok: false, message: 'reminderSent must be a boolean' };
    }
    result.reminderSent = body.reminderSent;
  }

  return { ok: true, value: result };
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

export const createTask = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isPlainObject(req.body)) {
      return res.status(400).json({ message: BODY_MUST_BE_OBJECT });
    }

    const parsed = parseTaskBody(req.body, { requireTitle: true });

    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const payload = parsed.value;

    const task = await Task.create({
      userId: req.user.id,
      title: payload.title,
      description: payload.description ?? '',
      completed: payload.completed ?? false,
      priority: payload.priority ?? 'medium',
      tags: payload.tags ?? [],
      dueDate: payload.dueDate,
      estimatedMinutes: payload.estimatedMinutes ?? 0,
      reminderSent: payload.reminderSent ?? false,
      completedAt: payload.completed ? new Date() : null,
    });

    return res.status(201).json({ task });
  } catch (error) {
    if (respondIfMongooseInputError(error, res)) return;
    return next(error);
  }
};

export const updateTask = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid task id' });
    }

    if (!isPlainObject(req.body)) {
      return res.status(400).json({ message: BODY_MUST_BE_OBJECT });
    }

    const parsed = parseTaskBody(req.body, { requireTitle: false });

    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const payload = parsed.value;

    const currentTask = await Task.findOne({ _id: req.params.id, userId: req.user.id });

    if (!currentTask) {
      return res.status(404).json({ message: 'Task not found' });
    }

    const nextCompleted = payload.completed ?? currentTask.completed;
    const wasCompleted = currentTask.completed;

    const update = {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.completed !== undefined ? { completed: payload.completed } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.dueDate !== undefined ? { dueDate: payload.dueDate } : {}),
      ...(payload.estimatedMinutes !== undefined ? { estimatedMinutes: payload.estimatedMinutes } : {}),
      ...(payload.reminderSent !== undefined ? { reminderSent: payload.reminderSent } : {}),
      ...(payload.completed !== undefined
        ? { completedAt: nextCompleted && !wasCompleted ? new Date() : nextCompleted ? currentTask.completedAt : null }
        : {}),
    };

    const task = await Task.findOneAndUpdate(
      { _id: req.params.id, userId: req.user.id },
      update,
      { returnDocument: 'after', runValidators: true },
    );

    return res.json({ task });
  } catch (error) {
    if (respondIfMongooseInputError(error, res)) return;
    return next(error);
  }
};

export const deleteTask = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ message: 'Invalid task id' });
    }

    const task = await Task.findOneAndDelete({ _id: req.params.id, userId: req.user.id });

    if (!task) {
      return res.status(404).json({ message: 'Task not found' });
    }

    return res.json({ message: 'Task deleted' });
  } catch (error) {
    if (respondIfMongooseInputError(error, res)) return;
    return next(error);
  }
};
