/**
 * 7-day task history snapshots.
 *
 * Stores one entry per day for the last 7 days in IndexedDB.
 * Updated automatically whenever the task list changes via persistTasks.
 * No server sync needed — it's a local productivity log.
 */

import { offlineDb } from './db';
import { Task } from '../types/task';

const HISTORY_KEY = 'task_history';
const MAX_DAYS    = 7;

export type HistoryEntry = {
  date: string;             // YYYY-MM-DD (local)
  completedCount: number;
  workDoneMinutes: number;
  completedTasks: { id: string; title: string; estimatedMinutes: number }[];
};

export type WeekHistory = HistoryEntry[]; // 7 entries, oldest → newest

// ── Helpers ──────────────────────────────────────────────────────────────────

const toLocalDateKey = (d: Date): string => {
  const yyyy = d.getFullYear();
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const dd   = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const wasCompletedOn = (task: Task, dateKey: string): boolean => {
  if (!task.completed) return false;
  const ts = task.completedAt ?? task.updatedAt;
  if (!ts) return false;
  return toLocalDateKey(new Date(ts)) === dateKey;
};

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * updateTodaySnapshot — call whenever the task list changes.
 * Reads all tasks, computes today's completed subset, and upserts the entry.
 * Prunes entries older than MAX_DAYS automatically.
 */
export const updateTodaySnapshot = async (tasks: Task[]): Promise<void> => {
  try {
    const todayKey      = toLocalDateKey(new Date());
    const completedToday = tasks.filter((t) => wasCompletedOn(t, todayKey));

    const entry: HistoryEntry = {
      date:             todayKey,
      completedCount:   completedToday.length,
      workDoneMinutes:  completedToday.reduce((sum, t) => sum + Math.max(0, t.estimatedMinutes), 0),
      completedTasks:   completedToday.map((t) => ({
        id:               t._id,
        title:            t.title,
        estimatedMinutes: t.estimatedMinutes,
      })),
    };

    const all   = (await offlineDb.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
    const fresh = all.filter((e) => e.date !== todayKey); // remove stale today entry

    // Prune anything older than MAX_DAYS
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_DAYS);
    const cutoffKey = toLocalDateKey(cutoff);
    const pruned  = fresh.filter((e) => e.date >= cutoffKey);

    const updated = [...pruned, entry].sort((a, b) => a.date.localeCompare(b.date));
    await offlineDb.set(HISTORY_KEY, updated);
  } catch (err) {
    console.warn('[history] Failed to update snapshot:', err);
  }
};

/**
 * getWeekHistory — returns exactly 7 entries (oldest first).
 * Days with no data get empty placeholders so the UI always shows a full week.
 */
export const getWeekHistory = async (): Promise<WeekHistory> => {
  try {
    const stored = (await offlineDb.get<HistoryEntry[]>(HISTORY_KEY)) ?? [];
    const byDate = new Map(stored.map((e) => [e.date, e]));

    const result: HistoryEntry[] = [];
    for (let i = MAX_DAYS - 1; i >= 0; i--) {
      const d   = new Date();
      d.setDate(d.getDate() - i);
      const key = toLocalDateKey(d);
      result.push(
        byDate.get(key) ?? {
          date: key, completedCount: 0, workDoneMinutes: 0, completedTasks: [],
        },
      );
    }
    return result;
  } catch {
    return [];
  }
};
