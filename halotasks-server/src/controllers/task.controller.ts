import { NextFunction, Response } from 'express';
import mongoose from 'mongoose';
import Task from '../models/Task.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { BODY_MUST_BE_OBJECT, isPlainObject } from '../utils/requestBody';
import { parsePagination } from '../utils/pagination';
import { TreeAwardError, awardPending, awardTaskCompletion, readPersistedGrowth } from '../utils/treeAward';
import type { GrowthResult } from '../utils/treeRules';
import { COMPLETION_ID_REUSED, parseTaskCompletionEvent, type TaskCompletionEvent } from '../utils/completionValidators';
import {
  discardJustRecorded,
  inspectEvent,
  newServerCompletionId,
  recordOwnedCompletion,
  type OwnedCompletion,
  type RecordResult,
  type RevokeResult,
} from '../utils/completionRecords';
import { applyTaskWrite, taskOwnsCompletion } from '../utils/taskCompletion';
import {
  DESCRIPTION_MAX_LENGTH,
  TAGS_MAX_COUNT,
  TAG_MAX_LENGTH,
  TASK_DUE_DATE_REMOVED,
  TITLE_MAX_LENGTH,
  isClearValue,
  isNonEmptyTitle,
  isValidDueTime,
  isValidEstimatedMinutes,
  isValidPriority,
  parseDueDate,
  parseStartTime,
  parseSubtasks,
  type Subtask,
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
const COMPLETION_EVENT_NEEDS_COMPLETED_CREATE = 'completionEvent on create requires completed: true';

/**
 * What the response says about the completion event, ONLY when the request carried one (so a legacy client's response
 * is unchanged). `rejected` means the task write happened but no record was made for it (the event is outside the
 * history window, or its id belongs to another event); history is never invented to cover it.
 */
type CompletionReport = { outcome: string; completionId?: string; code?: string; status?: string };

/** A completion event the server refuses refuses the whole request: nothing was changed (task, records, reward). */
const COMPLETION_EVENT_REFUSED = 'The completion event was refused; nothing was changed.';

const reportOf = (result: RecordResult | RevokeResult | undefined, carried: boolean): { completion: CompletionReport } | Record<string, never> => {
  if (!carried || !result) return {};
  const { outcome, completionId, code } = result;
  const status = 'status' in result ? result.status : undefined;
  return { completion: { outcome, ...(completionId ? { completionId } : {}), ...(code ? { code } : {}), ...(status ? { status } : {}) } };
};

type ParsedTaskBody = {
  title?: string;
  description?: string;
  completed?: boolean;
  /**
   * Issue #47: the completion transition this write carries, made by the client when the user acted. A completion when
   * `completed` is true, a revocation when it is false. Absent for clients that predate it (legacy path).
   */
  completionEvent?: TaskCompletionEvent;
  priority?: string;
  tags?: string[];
  /** Replaces the whole list when present (null already parsed to []); absent means "leave the stored subtasks alone". */
  subtasks?: Subtask[];
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

  // Completion event (Issue #47). Its kind follows `completed`, so the two cannot contradict each other.
  if (body.completionEvent !== undefined) {
    if (result.completed === undefined) {
      return { ok: false, message: 'completionEvent requires completed' };
    }
    const parsedEvent = parseTaskCompletionEvent(body.completionEvent, result.completed);
    if (!parsedEvent.ok) {
      return { ok: false, message: parsedEvent.message };
    }
    result.completionEvent = parsedEvent.value;
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

  // Subtasks (Issue #15). Absent = unchanged, so a client that predates the field can never clear them by accident.
  if (body.subtasks !== undefined) {
    const parsedSubtasks = parseSubtasks(body.subtasks);
    if (!parsedSubtasks.ok) {
      return { ok: false, message: parsedSubtasks.message };
    }
    result.subtasks = parsedSubtasks.value;
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

    // A revocation makes no sense for a task that does not exist yet.
    if (payload.completionEvent !== undefined && payload.completed !== true) {
      return res.status(400).json({ message: COMPLETION_EVENT_NEEDS_COMPLETED_CREATE });
    }

    // The completion a created-completed task holds is decided BEFORE the write so that it lands in the same document.
    // An event the server refuses (reused id, outside the window) refuses the whole request: nothing is created.
    const newTaskId = new mongoose.Types.ObjectId();
    const createPointer: { id: string | null; owned?: OwnedCompletion } = { id: null };
    if (payload.completed === true) {
      const snapshot = {
        taskId: String(newTaskId),
        titleSnapshot: payload.title as string,
        estimatedMinutesSnapshot: payload.estimatedMinutes ?? 0,
      };
      const event = payload.completionEvent;
      if (event?.kind === 'complete') {
        const input = {
          ...snapshot,
          completionId: event.completionId,
          completedAt: event.completedAt,
          utcOffsetMinutes: event.utcOffsetMinutes,
          localDate: event.localDate,
        };
        const inspected = await inspectEvent(req.user.id, input);
        if (inspected.kind === 'new') {
          createPointer.id = event.completionId;
          createPointer.owned = { fidelity: 'client', ...input };
        } else {
          // 'stored' cannot be this task's own (its id is new), so an id that is already stored belongs to another event
          return res.status(400).json({
            message: COMPLETION_EVENT_REFUSED,
            code: inspected.kind === 'refused' ? inspected.code : COMPLETION_ID_REUSED,
          });
        }
      } else {
        const id = newServerCompletionId();
        createPointer.id = id;
        createPointer.owned = { fidelity: 'server', completionId: id, ...snapshot };
      }
    }

    const task = await Task.create({
      _id: newTaskId,
      userId: req.user.id,
      title: payload.title,
      description: payload.description ?? '',
      completed: payload.completed ?? false,
      priority: payload.priority ?? 'medium',
      tags: payload.tags ?? [],
      subtasks: payload.subtasks ?? [],
      dueDate: payload.dueDate,
      dueTime: payload.dueTime,
      startTime: payload.startTime,
      estimatedMinutes: payload.estimatedMinutes ?? 0,
      reminderSent: payload.reminderSent ?? false,
      completedAt: payload.completed ? new Date() : null,
      completionId: createPointer.id,
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
    //
    // Completion record (Issue #47): the task is the arbiter, so it already carries the completion it holds (`completionId`,
    // set in the create above); the record follows it, BEFORE the award, so a failed award can be retried (see
    // utils/completionRecords.ts for the two kinds of consistency). A record this request inserted is withdrawn together
    // with the task it belonged to when the task is removed again, because the retry creates a NEW task id.
    let growth: GrowthResult | undefined;
    let completionResult: RecordResult | undefined;
    if (payload.completed === true) {
      const taskId = String(task._id);
      const removeCreatedTask = async (message: string) => {
        try {
          await Task.findOneAndDelete({ _id: task._id, userId: req.user.id });
        } catch {
          console.error(message);
        }
      };

      try {
        const owned = createPointer.owned as OwnedCompletion;
        completionResult = await recordOwnedCompletion(req.user.id, owned, () => taskOwnsCompletion(req.user.id, taskId, owned.completionId));
        if (completionResult.outcome === 'rejected') {
          // refused only now (a concurrent request stored the id for another event): nothing is created
          await removeCreatedTask('[Completion] A refused completion left a just-created task that could not be removed.');
          return res.status(400).json({ message: COMPLETION_EVENT_REFUSED, ...(completionResult.code ? { code: completionResult.code } : {}) });
        }
      } catch (recordError) {
        await removeCreatedTask('[Completion] Recording failed and the just-created task could not be removed.');
        throw recordError;
      }

      try {
        growth = await awardTaskCompletion(req.user.id, taskId);
      } catch (awardError) {
        if (awardError instanceof TreeAwardError && awardError.kind === 'derived_unpersisted') {
          growth = await readPersistedGrowth(req.user.id, taskId);
        } else {
          if (completionResult?.outcome === 'recorded' && completionResult.completionId) {
            try {
              await discardJustRecorded(req.user.id, completionResult.completionId, taskId);
            } catch {
              console.error('[Completion] Award failed and the just-recorded completion could not be withdrawn.');
            }
          }
          await removeCreatedTask('[Tree] Award failed and the just-created task could not be removed.');
          throw awardError;
        }
      }
    }

    return res.status(201).json({
      task,
      ...(growth ? { growth } : {}),
      ...reportOf(completionResult, payload.completionEvent !== undefined),
    });
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


    // Completion records and the Growth Tree award (Issue #47 Phase 1B, Issue #24). Order:
    //   task arbitration (ONE conditional write of completed + completionId) -> completion record -> convergence check -> award.
    // The award is idempotent by task id but permanent, so it runs only for a completion this request committed (or is the retry
    // of), and only while the task still holds it: a request that loses the arbitration, is superseded or is refused never
    // awards. Failures are retryable because the retry finds the task completed with the same completionId and finishes the
    // missing steps (record, then award):
    //  - the task write fails       -> nothing changed, the retry starts over;
    //  - the record write fails     -> the task holds the completion, the retry writes the record and awards;
    //  - the award fails, or its streak/derived write does not (derived_unpersisted) -> the task and record exist, the retry
    //    awards nothing more but finishes the derived write.
    // The task is looked up with {_id, userId} above, so only the caller's own task can be awarded.
    // See utils/taskCompletion.ts for the arbitration itself.
    const event = payload.completionEvent;
    const set = {
      ...(payload.title !== undefined ? { title: payload.title } : {}),
      ...(payload.description !== undefined ? { description: payload.description } : {}),
      ...(payload.priority !== undefined ? { priority: payload.priority } : {}),
      ...(payload.tags !== undefined ? { tags: payload.tags } : {}),
      ...(payload.subtasks !== undefined ? { subtasks: payload.subtasks } : {}),
      ...(payload.dueDate !== undefined ? { dueDate: payload.dueDate } : {}),
      ...(payload.dueTime !== undefined ? { dueTime: payload.dueTime } : {}),
      ...(payload.startTime !== undefined ? { startTime: payload.startTime } : {}),
      ...(payload.estimatedMinutes !== undefined ? { estimatedMinutes: payload.estimatedMinutes } : {}),
      ...(payload.reminderSent !== undefined ? { reminderSent: payload.reminderSent } : {}),
    };

    // `null` / '' remove a field outright; the due time goes with a cleared due date.
    const unset = {
      ...(payload.clear.dueDate ? { dueDate: 1, dueTime: 1 } : {}),
      ...(payload.clear.dueTime && payload.dueTime === undefined ? { dueTime: 1 } : {}),
      ...(payload.clear.startTime ? { startTime: 1 } : {}),
    };

    const outcome = await applyTaskWrite({
      userId: req.user.id,
      taskId: String(currentTask._id),
      current: { completed: currentTask.completed, completionId: currentTask.completionId ?? null },
      desired: payload.completed,
      event,
      snapshot: {
        titleSnapshot: payload.title ?? currentTask.title,
        estimatedMinutesSnapshot: payload.estimatedMinutes ?? currentTask.estimatedMinutes ?? 0,
      },
      award: async () => awardTaskCompletion(req.user.id, String(currentTask._id)),
      awardPending: async () => awardPending(req.user.id, String(currentTask._id)),
      write: (extraFilter, completionSet) => {
        const fullSet = { ...set, ...completionSet };
        return Task.findOneAndUpdate(
          {
            _id: req.params.id,
            userId: req.user.id,
            ...(relyOnStoredDueDate ? { dueDate: { $exists: true, $ne: null } } : {}),
            ...extraFilter,
          },
          {
            ...(Object.keys(fullSet).length > 0 ? { $set: fullSet } : {}),
            ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
          },
          { returnDocument: 'after', runValidators: true },
        );
      },
    });
    if (outcome.refused) {
      return res.status(400).json({ message: COMPLETION_EVENT_REFUSED, code: outcome.refused });
    }
    const task = outcome.task;
    const growth = outcome.growth;
    const completionResult = outcome.result;

    if (!task && !relyOnStoredDueDate) {
      return res.status(404).json({ message: 'Task not found' });
    }

    if (!task && relyOnStoredDueDate) {
      // The task existed a moment ago (read above), so the only way to miss is that its due date was removed or the
      // task was deleted in between. Nothing was written. Read it again to say which: only "the due date is gone"
      // carries the code that clients recover from (Issue #43). Every other miss keeps the plain 409 it always had.
      const latest = await Task.findOne({ _id: req.params.id, userId: req.user.id });
      const message = 'Task changed while it was being updated; reload and try again';
      return res
        .status(409)
        .json(latest && latest.dueDate == null ? { message, code: TASK_DUE_DATE_REMOVED } : { message });
    }

    return res.json({ task, ...(growth ? { growth } : {}), ...reportOf(completionResult, event !== undefined) });
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
