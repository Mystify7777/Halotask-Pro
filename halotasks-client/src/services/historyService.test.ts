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

// Issue #48, 48B: the Insights reader relies on this contract (it has no try/catch of its own, so a rejection would escape
// it): getHistory NEVER rejects. Every transport or parsing failure is the same `null` ("could not be read"), and the
// reader turns `null` into the device fallback. If this ever changes, the reader needs a narrow catch at the same time.
describe('historyService.getHistory: never rejects, every failure is null', () => {
  beforeEach(() => {
    api.get.mockReset();
    api.put.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it.each([
    ['a network error', () => Promise.reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }))],
    ['a timeout', () => Promise.reject(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }))],
    ['a 401', () => Promise.reject(Object.assign(new Error('401'), { response: { status: 401, data: {} } }))],
    ['a 500', () => Promise.reject(Object.assign(new Error('500'), { response: { status: 500, data: {} } }))],
    ['a cancelled request', () => Promise.reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))],
    ['a thrown string', () => Promise.reject('boom')],
    ['a thrown undefined', () => Promise.reject(undefined)],
    ['a synchronous throw from the client', () => { throw new Error('sync'); }],
    ['an empty response', () => Promise.resolve(undefined)],
    ['a body with no history', () => Promise.resolve({ data: {} })],
    ['a body whose history is not a list', () => Promise.resolve({ data: { history: 'nope' } })],
    ['a null body', () => Promise.resolve({ data: null })],
  ])('%s -> null, no rejection', async (_name, behave) => {
    api.get.mockImplementationOnce(behave as () => Promise<unknown>);
    await expect(historyService.getHistory(90, '2026-09-30')).resolves.toBeNull();
  });

  it('only ever issues a GET', async () => {
    api.get.mockRejectedValueOnce(new Error('x'));
    await historyService.getHistory(90, '2026-09-30');
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('rows it cannot parse are dropped, so a damaged answer comes back SHORT (the reader then refuses it)', async () => {
    const rows = await fetchRows([row({ date: '2026-09-29' }), { nonsense: true }, row()]);
    expect(rows).toHaveLength(2);
  });
});
