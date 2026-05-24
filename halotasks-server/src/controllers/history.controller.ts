import { NextFunction, Request, Response } from 'express';
import DayHistory from '../models/DayHistory.model';

// -- GET /api/history?days=7 --
export const getHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const days = Math.min(Number(req.query.days) || 7, 90); // cap at 90

    // Build the date strings for the last N days (YYYY-MM-DD)
    const dates: string[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }

    const stored = await DayHistory.find({
      userId,
      date: { $in: dates },
    }).lean();

    const byDate = new Map(stored.map((e) => [e.date, e]));

    // Return a full N-entry array with zeros for missing days so the client
    // doesn't need special-case handling.
    const entries = dates.map((date) => {
      const entry = byDate.get(date);
      return {
        date,
        completedCount: entry?.completedCount ?? 0,
        workDoneMinutes: entry?.workDoneMinutes ?? 0,
        completedTasks: entry?.completedTasks ?? [],
      };
    });

    return res.json({ history: entries });
  } catch (error) {
    return next(error);
  }
};

// -- PUT /api/history/today --
// Body: { date, completedCount, workDoneMinutes, completedTasks }
// Upserts (replaces) the entry for the given date.
export const upsertTodayHistory = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.id;
    const { date, completedCount, workDoneMinutes, completedTasks } = req.body as {
      date: string;
      completedCount: number;
      workDoneMinutes: number;
      completedTasks: { taskId: string; title: string; estimatedMinutes: number }[];
    };

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'Invalid or missing date (expected YYYY-MM-DD).' });
    }

    const entry = await DayHistory.findOneAndUpdate(
      { userId, date },
      {
        $set: {
          completedCount: Number(completedCount) || 0,
          workDoneMinutes: Number(workDoneMinutes) || 0,
          completedTasks: Array.isArray(completedTasks) ? completedTasks : [],
        },
      },
      { upsert: true, new: true },
    );

    return res.json({ entry });
  } catch (error) {
    return next(error);
  }
};
