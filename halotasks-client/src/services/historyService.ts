import { apiClient } from './api';
import type { HistoryEntry, WeekHistory } from '../offline/history';

export const historyService = {
  /**
   * Upsert today's snapshot to the server.
   * Fire-and-forget safe — errors are caught and logged, never thrown.
   */
  upsertToday: async (entry: HistoryEntry): Promise<void> => {
    try {
      await apiClient.put('/api/history/today', {
        date: entry.date,
        completedCount: entry.completedCount,
        workDoneMinutes: entry.workDoneMinutes,
        completedTasks: entry.completedTasks.map((t) => ({
          taskId: t.id,
          title: t.title,
          estimatedMinutes: t.estimatedMinutes,
        })),
      });
    } catch (err) {
      console.warn('[historyService] Failed to sync today snapshot:', err);
    }
  },

  /**
   * Fetch the last N days of history from the server.
   * Falls back to an empty array on error so callers don't need to handle failures.
   */
  getHistory: async (days = 7): Promise<WeekHistory> => {
    try {
      const res = await apiClient.get(`/api/history?days=${days}`);
      return res.data.history as WeekHistory;
    } catch (err) {
      console.warn('[historyService] Failed to fetch history:', err);
      return [];
    }
  },
};
