import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('./api', () => ({ apiClient: api }));

import { historyService } from './historyService';

// Issue #47, Phase 2C: the client reads which source answered each day, and ignores what it does not know.
const row = (over: Record<string, unknown> = {}) => ({
  date: '2026-09-30',
  completedCount: 1,
  workDoneMinutes: 10,
  completedTasks: [{ taskId: 't1', title: 'T', estimatedMinutes: 10 }],
  updatedAt: '2026-09-30T05:00:00.000Z',
  ...over,
});
const fetchRows = async (rows: unknown[]) => {
  api.get.mockResolvedValueOnce({ data: { history: rows } });
  return historyService.getHistory(1, '2026-09-30');
};

describe('historyService.getHistory: the `source` of each day', () => {
  beforeEach(() => api.get.mockReset());

  it.each(['canonical', 'legacy', 'none'] as const)('passes the known source %s through', async (source) => {
    expect((await fetchRows([row({ source })]))?.[0].source).toBe(source);
  });

  it.each([undefined, null, '', 'mystery', 'CANONICAL', 1, true, {}])('treats %j as "not said" (null), so the client behaves as before', async (source) => {
    expect((await fetchRows([row({ source })]))?.[0].source).toBeNull();
  });

  it('keeps the rest of the parse unchanged: existence from updatedAt, tasks mapped taskId -> id', async () => {
    const [entry] = (await fetchRows([row({ source: 'canonical' })])) ?? [];
    expect(entry.exists).toBe(true);
    expect(entry.entry.completedTasks).toEqual([{ id: 't1', title: 'T', estimatedMinutes: 10 }]);
    expect((await fetchRows([row({ updatedAt: null, source: 'none' })]))?.[0].exists).toBe(false);
  });
});
