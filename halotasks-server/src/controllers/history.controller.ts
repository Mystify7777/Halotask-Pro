import { NextFunction, Response } from 'express';
import DayHistory from '../models/DayHistory.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import {
  buildDateWindow,
  parseHistoryQuery,
  parseHistoryUpsert,
} from '../utils/historyValidators';

// Date contract: see utils/calendarDate.ts. History dates are the user's LOCAL calendar
// days. The client declares its UTC offset on every request (`utcOffsetMinutes`) and the
// server validates "today" from its clock + that offset (exactly one date; no tolerance).
// There is no UTC fallback. A date that is not today / out of range returns 400 with a
// machine-readable `code` (DATE_NOT_TODAY | DATE_OUT_OF_RANGE) because it depends on the server's
// clock and may succeed on a later attempt; every other 400 means the payload itself is invalid.

// -- GET /api/history?days=7&endDate=YYYY-MM-DD&utcOffsetMinutes=330 --
// `endDate` and `utcOffsetMinutes` are required. Returns exactly `days` entries
// (oldest → newest) ending at `endDate` (the client's local today).
// Days with no stored snapshot come back as zeros with `updatedAt: null`, so a
// client can tell "no record" from "a record that is genuinely zero".
export const getHistory = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.id;

    const parsed = parseHistoryQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) });
    }

    const dates = buildDateWindow(parsed.value.days, parsed.value.endDate);

    const stored = await DayHistory.find({
      userId,
      date: { $in: dates },
    }).lean();

    const byDate = new Map(stored.map((e) => [e.date, e]));

    const entries = dates.map((date) => {
      const entry = byDate.get(date);
      return {
        date,
        completedCount: entry?.completedCount ?? 0,
        workDoneMinutes: entry?.workDoneMinutes ?? 0,
        completedTasks: entry?.completedTasks ?? [],
        updatedAt: entry?.updatedAt ?? null,
      };
    });

    return res.json({ history: entries });
  } catch (error) {
    return next(error);
  }
};

const upsertHistory = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
  mode: 'today' | 'backfill',
) => {
  try {
    const userId = req.user.id;

    const parsed = parseHistoryUpsert(req.body, {
      mode,
      pathDate: typeof req.params.date === 'string' ? req.params.date : undefined,
    });
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) });
    }

    const { date, completedCount, workDoneMinutes, completedTasks } = parsed.value;

    const entry = await DayHistory.findOneAndUpdate(
      { userId, date },
      { $set: { completedCount, workDoneMinutes, completedTasks } },
      { upsert: true, returnDocument: 'after' },
    );

    return res.json({ entry });
  } catch (error) {
    return next(error);
  }
};

// -- PUT /api/history/today --
// Body: { date, utcOffsetMinutes, completedCount, workDoneMinutes, completedTasks }
// Replaces (never adds to) the stored snapshot for the client's current calendar day.
// `date` must be today's date at `utcOffsetMinutes`; past/future dates are rejected.
// The client always sends a snapshot it has already merged with the server's (by task id),
// so a replace here does not drop another device's tasks.
export const upsertTodayHistory = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  upsertHistory(req, res, next, 'today');

// -- PUT /api/history/:date --
// Bounded backfill, used by the client to deliver a snapshot after its own day has ended
// (e.g. work recorded offline before midnight, synced the next day). Same body and
// validation as /today; the date must be within the last 7 days and not in the future.
export const upsertHistoryForDate = (req: AuthenticatedRequest, res: Response, next: NextFunction) =>
  upsertHistory(req, res, next, 'backfill');
