import { NextFunction, Response } from 'express';
import DayHistory from '../models/DayHistory.model';
import { readCompletionDays } from '../utils/completionHistory';
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
// Days with no stored data come back as zeros with `updatedAt: null`, so a
// client can tell "no record" from "a record that is genuinely zero".
//
// TRANSITIONAL READ CONTRACT (Issue #47, Phase 2A). Each day is answered from ONE source, chosen per day:
//   1. CANONICAL: the day has CompletionRecords (utils/completionHistory.ts). The entry is derived from them (active records
//      only; deleted tasks stay, because a record carries its own title and estimate; the day is the record's `localDate`).
//      A day whose records are all revoked is canonical too and reads as zero.
//   2. LEGACY: no record has that local day, so the day's DayHistory snapshot is used exactly as stored.
//   3. NONE: neither has the day: zeros, `updatedAt: null`.
// The two sources are never merged, added or deduplicated by task/date: a day is wholly one or the other, so nothing can be
// counted twice, and a day with canonical data never has its legacy snapshot mixed in. The choice is per day, not per
// request, so a few new records cannot hide the rest of a week that only the legacy snapshots know about. The response
// shape is unchanged for every day, whichever source answered it, plus ONE additive key (Phase 2C): `source` is 'canonical'
// (answered from CompletionRecords), 'legacy' (a DayHistory snapshot answered) or 'none' (zeros). It exists so a client can
// tell a day whose history the records own (a legacy PUT for it is acknowledged but never read) from a legacy day; existing
// clients ignore the key.
// `updatedAt` of a canonical day is the latest server receipt/revocation time of its records, not a completion time; it only
// signals "a record exists" (never null for a canonical day). Legacy writes (PUT /api/history/*) are still accepted and stored,
// but for a canonical day they are not authoritative: they are never read, so a client's unsent local changes to such a day are
// discarded when it next reconciles, until the client history writes are retired (Phase 2C).
export const getHistory = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const userId = req.user.id;

    const parsed = parseHistoryQuery(req.query as Record<string, unknown>);
    if (!parsed.ok) {
      return res.status(400).json({ message: parsed.message, ...(parsed.code ? { code: parsed.code } : {}) });
    }

    const dates = buildDateWindow(parsed.value.days, parsed.value.endDate);

    const canonical = await readCompletionDays(userId, dates);

    // Legacy snapshots are only needed for the days the canonical source does not know.
    const legacyDates = dates.filter((date) => !canonical.has(date));
    const stored = legacyDates.length === 0 ? [] : await DayHistory.find({ userId, date: { $in: legacyDates } }).lean();
    const legacy = new Map(stored.map((e) => [e.date, e]));

    const entries = dates.map((date) => {
      const record = canonical.get(date);
      if (record) {
        return {
          date,
          completedCount: record.completedCount,
          workDoneMinutes: record.workDoneMinutes,
          completedTasks: record.completedTasks,
          updatedAt: record.updatedAt,
          source: 'canonical' as const,
        };
      }
      const entry = legacy.get(date);
      return {
        date,
        completedCount: entry?.completedCount ?? 0,
        workDoneMinutes: entry?.workDoneMinutes ?? 0,
        completedTasks: entry?.completedTasks ?? [],
        updatedAt: entry?.updatedAt ?? null,
        source: entry ? ('legacy' as const) : ('none' as const),
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
