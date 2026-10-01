import axios from 'axios';
import { apiClient } from './api';
import type { HistoryEntry } from '../offline/history';
import { getUtcOffsetMinutes, isValidDateKey } from '../utils/localDate';

/**
 * How an upsert ended:
 *  - 'synced'   the server has this snapshot
 *  - 'retry'    transient (offline, timeout, 5xx, auth) — keep it pending and try later
 *  - 'rejected' the server refused it as invalid (400) — retrying the same payload cannot help
 */
export type UpsertOutcome = 'synced' | 'retry' | 'rejected';

/** A server history row. `exists` is false for the zero placeholders the API returns for days with no record. */
export type ServerHistoryEntry = { entry: HistoryEntry; exists: boolean };

const toPayload = (entry: HistoryEntry) => ({
  date: entry.date,
  utcOffsetMinutes: getUtcOffsetMinutes(), // the server validates "today" from this; there is no UTC fallback
  completedCount: entry.completedCount,
  workDoneMinutes: entry.workDoneMinutes,
  completedTasks: entry.completedTasks.map((t) => ({
    taskId: t.id,
    title: t.title,
    estimatedMinutes: t.estimatedMinutes,
  })),
});

/**
 * A 400 means "this payload is invalid" EXCEPT when the server tags it with a DATE_* code: the date
 * check depends on the server's clock (exactly one date is "today"), so a device whose clock is a few
 * seconds off at local midnight is rejected now and accepted a moment later. Keep that pending.
 */
const outcomeFor = (err: unknown): UpsertOutcome => {
  if (axios.isAxiosError(err) && err.response?.status === 400) {
    const code = (err.response.data as { code?: unknown } | undefined)?.code;
    return typeof code === 'string' && code.startsWith('DATE_') ? 'retry' : 'rejected';
  }
  return 'retry';
};

const isNonNegativeNumber = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Defensive parse: never trust server JSON blindly before it lands in local storage. */
const parseServerEntry = (raw: unknown): ServerHistoryEntry | null => {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (!isValidDateKey(r.date)) return null;
  if (!isNonNegativeNumber(r.completedCount) || !isNonNegativeNumber(r.workDoneMinutes)) return null;
  if (!Array.isArray(r.completedTasks)) return null;

  const completedTasks: HistoryEntry['completedTasks'] = [];
  for (const t of r.completedTasks) {
    if (typeof t !== 'object' || t === null) return null;
    const task = t as Record<string, unknown>;
    if (typeof task.taskId !== 'string' || typeof task.title !== 'string' || !isNonNegativeNumber(task.estimatedMinutes)) {
      return null;
    }
    completedTasks.push({ id: task.taskId, title: task.title, estimatedMinutes: task.estimatedMinutes });
  }

  return {
    exists: typeof r.updatedAt === 'string' && r.updatedAt.length > 0,
    entry: {
      date: r.date,
      completedCount: r.completedCount,
      workDoneMinutes: r.workDoneMinutes,
      completedTasks,
    },
  };
};

export const historyService = {
  /**
   * Upsert the snapshot for the client's current calendar day (PUT /api/history/today).
   * Never throws; the outcome tells the caller whether to keep it pending.
   */
  upsertToday: async (entry: HistoryEntry): Promise<UpsertOutcome> => {
    try {
      await apiClient.put('/api/history/today', toPayload(entry));
      return 'synced';
    } catch (err) {
      console.warn('[historyService] Failed to sync today snapshot:', err);
      return outcomeFor(err);
    }
  },

  /**
   * Upsert a snapshot for an earlier day in the last 7 (PUT /api/history/:date) —
   * e.g. work recorded offline before midnight that could not be delivered that day.
   */
  upsertForDate: async (entry: HistoryEntry): Promise<UpsertOutcome> => {
    try {
      await apiClient.put(`/api/history/${entry.date}`, toPayload(entry));
      return 'synced';
    } catch (err) {
      console.warn('[historyService] Failed to backfill snapshot for', entry.date, err);
      return outcomeFor(err);
    }
  },

  /**
   * Fetch the N days ending at `endDate` (the client's local today, at its current UTC offset) from the server.
   * Returns `null` when the server could not be reached or answered badly, so callers can
   * tell "unreachable" (keep local data) apart from "reachable but empty".
   */
  getHistory: async (days: number, endDate: string): Promise<ServerHistoryEntry[] | null> => {
    try {
      const res = await apiClient.get('/api/history', {
        params: { days, endDate, utcOffsetMinutes: getUtcOffsetMinutes() },
        timeout: 10_000,
      });
      const rows: unknown = res.data?.history;
      if (!Array.isArray(rows)) return null;

      const parsed: ServerHistoryEntry[] = [];
      for (const row of rows) {
        const entry = parseServerEntry(row);
        if (entry) parsed.push(entry);
      }
      return parsed;
    } catch (err) {
      console.warn('[historyService] Failed to fetch history:', err);
      return null;
    }
  },
};
