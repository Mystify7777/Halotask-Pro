import { NextFunction, Response } from 'express';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import mongoose from 'mongoose';
import Task from '../models/Task.model';
import { COMPLETION_NOT_FOUND, COMPLETION_TASK_EXISTS, parseStandaloneEvent } from '../utils/completionValidators';
import { findCompletion, recordCompletion, revokeCompletion } from '../utils/completionRecords';

// The task a standalone event names, when it is a real task of this account (a `local-*` id never is).
const existingTask = async (userId: string, taskId: string | undefined) => {
  if (!taskId || !mongoose.Types.ObjectId.isValid(taskId)) return null;
  return (await Task.findOne({ _id: taskId, userId }).lean()) as unknown as { completed: boolean; completionId?: string | null } | null;
};

const TASK_EXISTS_MESSAGE = 'This task still exists; send the completion with the task update instead.';

// -- POST /api/completion-events (Issue #47) --
// Delivers ONE completion event whose task cannot be written: the task was deleted before the event reached the server,
// or it was created and deleted offline and never existed here. A task that does exist normally carries its event on the
// task write (`completionEvent` on PUT/POST /api/tasks); both paths use the same service, so one completionId is one record
// however it arrives.
//
// Body (the event is self-contained, there is no task to read a snapshot from):
//   { type: 'complete', completionId, taskId, title, estimatedMinutes, completedAt, utcOffsetMinutes, localDate? }
//   { type: 'revoke',   completionId, taskId?, revokedAt }
// `taskId` is stored exactly as sent. A `local-*` id is NOT looked up as a server task: nothing here resolves it.
//
// Answers (every one is idempotent: sending the same event again changes nothing):
//   201 { completion: { outcome: 'recorded' | 'superseded', completionId } }
//   200 { completion: { outcome: 'duplicate', completionId, status } }     the event was already stored
//   200 { completion: { outcome: 'revoked' | 'already_revoked', completionId } }
//   400 { message }                                                         the payload is invalid (permanent)
//   400 { message, code }  COMPLETION_TIME_OUT_OF_WINDOW | COMPLETION_ID_REUSED | COMPLETION_TASK_MISMATCH
//                                                                           refused; the same payload can never work
//   409 { message, code: COMPLETION_TASK_EXISTS }                          the task still exists: use the task write
//   404 { message, code: COMPLETION_NOT_FOUND }                            a revoke for an id this account never recorded
export const postCompletionEvent = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const parsed = parseStandaloneEvent(req.body);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message });
    }
    const event = parsed.value;
    const userId = req.user.id;

    if (event.kind === 'complete') {
      // Phase 1B: for a task that still exists the task write arbitrates (utils/taskCompletion.ts); this endpoint would bypass
      // it. An event that is already stored is still answered (duplicate / reused), so retries stay idempotent.
      if ((await existingTask(userId, event.taskId)) && !(await findCompletion(userId, event.completionId))) {
        return res.status(409).json({ message: TASK_EXISTS_MESSAGE, code: COMPLETION_TASK_EXISTS });
      }
      const result = await recordCompletion(userId, {
        completionId: event.completionId,
        taskId: event.taskId,
        titleSnapshot: event.title,
        estimatedMinutesSnapshot: event.estimatedMinutes,
        completedAt: event.completedAt,
        utcOffsetMinutes: event.utcOffsetMinutes,
        localDate: event.localDate,
      });

      if (result.outcome === 'rejected') {
        return res.status(400).json({ message: 'The completion event was refused.', ...(result.code ? { code: result.code } : {}) });
      }
      const { outcome, completionId, status } = result;
      return res
        .status(outcome === 'duplicate' ? 200 : 201)
        .json({ completion: { outcome, completionId, ...(status ? { status } : {}) } });
    }

    // A revoke of the completion a live, completed task currently holds is the task's to make, not this endpoint's.
    const stored = await findCompletion(userId, event.completionId);
    const holder = await existingTask(userId, event.taskId ?? stored?.taskId);
    if (holder && holder.completed && holder.completionId === event.completionId) {
      return res.status(409).json({ message: TASK_EXISTS_MESSAGE, code: COMPLETION_TASK_EXISTS });
    }

    const result = await revokeCompletion(userId, {
      completionId: event.completionId,
      ...(event.taskId ? { taskId: event.taskId } : {}),
      revokedAt: event.revokedAt,
    });

    if (result.outcome === 'not_found') {
      return res.status(404).json({ message: 'No such completion.', code: COMPLETION_NOT_FOUND });
    }
    if (result.outcome === 'rejected') {
      return res.status(400).json({ message: 'The completion event was refused.', ...(result.code ? { code: result.code } : {}) });
    }
    return res.status(200).json({ completion: { outcome: result.outcome, completionId: result.completionId } });
  } catch (error) {
    return next(error);
  }
};
