import { NextFunction, Response } from 'express';
import mongoose from 'mongoose';
import Task from '../models/Task.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { BODY_MUST_BE_OBJECT, isPlainObject } from '../utils/requestBody';
import { parsePagination } from '../utils/pagination';
import { TreeAwardError, awardTaskCompletion, readPersistedGrowth } from '../utils/treeAward';
import type { GrowthResult } from '../utils/treeRules';
import {
  DESCRIPTION_MAX_LENGTH,
  TAGS_MAX_COUNT,
  TAG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  isClearValue,
  isNonEmptyTitle,
  isValidDueTime,
  isValidEstimatedMinutes,
  isValidPriority,
  parseDueDate,
  parseStartTime,
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

const DUE_TIME_NEEDS_DUE_DATE = 'dueTime requires a dueDate';

type ParsedTaskBody = {
  title?: string;
  description?: string;
  completed?: boolean;
  priority?: string;
  tags?: string[];
  dueDate?: Date;
  dueTime?: string;
  startTime?: Date;
  /** Optional fields the request asked to clear (`null` or `''`). Meaningful on update; ignored on create. */
  clear: { dueDate: boolean; dueTime: boolean; startTime: boolean };
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
  const result: ParsedTaskBody = { clear: { dueDate: false, dueTime: false, startTime: false } };

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
    } else {
      result.clear.dueDate = true; // null / '' : remove the due date (before this, an update silently ignored it)
    }
  }

  // Due time (Issue #10) and start time (Issue #9): optional, strict, and clearable the same way.
  if (body.dueTime !== undefined) {
    if (isClearValue(body.dueTime)) {
      result.clear.dueTime = true;
    } else if (!isValidDueTime(body.dueTime)) {
      return { ok: false, message: 'dueTime must be a time of day in HH:mm (24-hour) form' };
    } else {
      result.dueTime = body.dueTime;
    }
  }

  if (body.startTime !== undefined) {
    if (isClearValue(body.startTime)) {
      result.clear.startTime = true;
    } else {
      const parsedStartTime = parseStartTime(body.startTime);
      if (!parsedStartTime.ok) {
        return { ok: false, message: 'startTime must be an ISO 8601 date-time with a time zone (e.g. 2026-10-20T09:30:00Z)' };
      }
      result.startTime = parsedStartTime.value;
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

    // A due time is only a part of a deadline: it needs the due date it belongs to.
    if (payload.dueTime !== undefined && payload.dueDate === undefined) {
      return res.status(400).json({ message: DUE_TIME_NEEDS_DUE_DATE });
    }

    const task = await Task.create({
      userId: req.user.id,
      title: payload.title,
      description: payload.description ?? '',
      completed: payload.completed ?? false,
      priority: payload.priority ?? 'medium',
      tags: payload.tags ?? [],
      dueDate: payload.dueDate,
      dueTime: payload.dueTime,
      startTime: payload.startTime,
      estimatedMinutes: payload.estimatedMinutes ?? 0,
      reminderSent: payload.reminderSent ?? false,
      completedAt: payload.completed ? new Date() : null,
    });

    // Growth Tree (Issue #24): a task created already completed (an offline create-then-complete is
    // delivered this way) earns its award once, here. The task id only exists now, so the task is
    // written first. Two different failures, handled differently:
    //  - the award was NOT recorded: the new task is removed again and the request fails, so a retry
    //    creates it afresh and is awarded exactly once, instead of leaving a completed, unrewarded task;
    //  - the award IS recorded but its streak/derived write is not (derived_unpersisted): the task and
    //    its XP are kept (deleting the task would orphan the XP, and a retry would create a second task
    //    and be awarded again). The response carries the tree as persisted, read back, never projected
    //    (or no growth block if even that read fails); the leftover marker is reconciled by the next
    //    award, so nothing is lost.
    let growth: GrowthResult | undefined;
    if (payload.completed === true) {
      try {
        growth = await awardTaskCompletion(req.user.id, String(task._id));
      } catch (awardError) {
        if (awardError instanceof TreeAwardError && awardError.kind === 'derived_unpersisted') {
          growth = await readPersistedGrowth(req.user.id, String(task._id));
        } else {
          try {
            await Task.findOneAndDelete({ _id: task._id, userId: req.user.id });
          } catch {
            console.error('[Tree] Award failed and the just-created task could not be removed.');
          }
          throw awardError;
        }
      }
    }

    return res.status(201).json({ task, ...(growth ? { growth } : {}) });
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

    // Deadline fields (Issue #10): the due time must always sit next to a due date.
    //  - a due time in the request needs a due date, either in the request or already on the task;
    //  - clearing the due date clears the due time with it (a time with no day is meaningless), but a request
    //    that clears the date AND sets a time contradicts itself and is rejected.
    const dueDateAfter = payload.clear.dueDate ? false : payload.dueDate !== undefined || currentTask.dueDate != null;
    if (payload.dueTime !== undefined && !dueDateAfter) {
      return res.status(400).json({ message: DUE_TIME_NEEDS_DUE_DATE });
    }
    // The time is being set against the due date ALREADY stored (the request did not send one). Another request
    // could clear that date between this read and the write, so the write itself requires the date to still be there.
    const relyOnStoredDueDate = payload.dueTime !== undefined && payload.dueDate === undefined;

    const nextCompleted = payload.completed ?? currentTask.completed;
    const wasCompleted = currentTask.completed;

    // Growth Tree (Issue #24): the incomplete -> complete transition earns the award, BEFORE the task is
    // written. The award is idempotent by task id, so ordering it first makes every failure retryable:
    //  - the award fails        -> the request fails and the task is untouched; a retry sees the same
    //                              transition and awards once;
    //  - the award is recorded but its streak/derived write is not (derived_unpersisted) -> the request
    //                              fails and the task is untouched; the retry awards nothing more, finishes
    //                              the derived write, and completes the task;
    //  - the task write fails   -> the award is already recorded, the retry awards nothing more, so a
    //                              task never yields more than one award (it may briefly hold one while
    //                              incomplete, never a second);
    //  - a retry / duplicate / uncomplete -> re-complete finds the id in the ledger and awards nothing.
    // The task is looked up with {_id, userId} above, so only the caller's own task can be awarded.
    let growth: GrowthResult | undefined;
    if (nextCompleted && !wasCompleted) {
      growth = await awardTaskCompletion(req.user.id, String(currentTask._id));
    }

    const set = {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.completed !== undefined ? { completed: payload.completed } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.dueDate !== undefined ? { dueDate: payload.dueDate } : {}),
      ...(payload.dueTime !== undefined ? { dueTime: payload.dueTime } : {}),
      ...(payload.startTime !== undefined ? { startTime: payload.startTime } : {}),
      ...(payload.estimatedMinutes !== undefined ? { estimatedMinutes: payload.estimatedMinutes } : {}),
      ...(payload.reminderSent !== undefined ? { reminderSent: payload.reminderSent } : {}),
      ...(payload.completed !== undefined
        ? { completedAt: nextCompleted && !wasCompleted ? new Date() : nextCompleted ? currentTask.completedAt : null }
        : {}),
    };

    // `null` / '' remove a field outright; the due time goes with a cleared due date.
    const unset = {
      ...(payload.clear.dueDate ? { dueDate: 1, dueTime: 1 } : {}),
      ...(payload.clear.dueTime && payload.dueTime === undefined ? { dueTime: 1 } : {}),
      ...(payload.clear.startTime ? { startTime: 1 } : {}),
    };

    const task = await Task.findOneAndUpdate(
      {
        _id: req.params.id,
        userId: req.user.id,
        ...(relyOnStoredDueDate ? { dueDate: { $exists: true, $ne: null } } : {}),
      },
      {
        ...(Object.keys(set).length > 0 ? { $set: set } : {}),
        ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
      },
      { returnDocument: 'after', runValidators: true },
    );

    if (!task && relyOnStoredDueDate) {
      // The task existed a moment ago (read above), so the only way to miss is that its due date was removed or the
      // task was deleted in between. Nothing was written.
      return res.status(409).json({ message: 'Task changed while it was being updated; reload and try again' });
    }

    return res.json({ task, ...(growth ? { growth } : {}) });
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
