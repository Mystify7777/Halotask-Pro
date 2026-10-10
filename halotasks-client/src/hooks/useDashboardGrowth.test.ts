import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #24 — the dashboard's tree is the server's. A local (offline) completion is a preview in React
// state only: nothing is stored, nothing is sent, and the server's answer replaces it exactly.

const idb = vi.hoisted(() => new Map<string, unknown>());

vi.mock('../offline/db', () => ({
  offlineDb: {
    get: vi.fn(async (key: string) => (idb.has(key) ? idb.get(key) : null)),
    set: vi.fn(async (key: string, value: unknown) => {
      idb.set(key, value);
    }),
    remove: vi.fn(async (key: string) => {
      idb.delete(key);
    }),
  },
}));

vi.mock('../services/treeService', () => ({ treeService: { getTree: vi.fn() } }));

import { offlineDb } from '../offline/db';
import { treeService } from '../services/treeService';
import { resetCache } from '../growth/treeStorage';
import type { GrowthResult, TreeStateJSON } from '../growth/treeTypes';
import { useAuthStore } from '../store/authStore';
import { useDashboardGrowth } from './useDashboardGrowth';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const serverTree = (xp: number, awardedTaskIds: string[] = []): TreeStateJSON => ({
  xp, leaves: Math.floor(xp / 20), streakDays: 1, lastActiveDate: '2026-10-06', health: 'healthy', stage: 'seed',
  lastCalculatedAt: '2026-10-06T00:00:00.000Z', awardedTaskIds,
});
const growth = (taskId: string, xp: number, awarded = true): GrowthResult => {
  const { awardedTaskIds: _l, ...summary } = serverTree(xp);
  void _l;
  return { taskId, awarded, xpGained: awarded ? 10 : 0, treeState: summary };
};

beforeEach(() => {
  idb.clear();
  resetCache();
  vi.mocked(offlineDb.set).mockClear();
  vi.mocked(treeService.getTree).mockReset().mockResolvedValue(serverTree(100, ['old']));
  useAuthStore.setState({ token: 't', user: USER });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

const ready = async () => {
  const hook = renderHook(() => useDashboardGrowth());
  await waitFor(() => expect(hook.result.current.treeState).not.toBeNull());
  await act(async () => { await Promise.resolve(); });
  vi.mocked(offlineDb.set).mockClear();
  return hook;
};

describe('useDashboardGrowth', () => {
  it('starts from the server tree', async () => {
    const { result } = await ready();
    expect(result.current.treeState?.xp).toBe(100);
  });

  it('an offline completion previews +10 in React state but persists nothing and sends nothing', async () => {
    const { result } = await ready();

    act(() => result.current.previewGrowthForCompletion('local-1-abc'));

    expect(result.current.treeState?.xp).toBe(110);
    expect(offlineDb.set).not.toHaveBeenCalled();
    expect(idb.get('growth_tree:user-a')).toMatchObject({ xp: 100 }); // the stored copy is still the server's
    expect(vi.mocked(treeService.getTree)).toHaveBeenCalledTimes(1); // and no write method even exists
  });

  it('previewing the same task twice is still +10 (idempotent preview)', async () => {
    const { result } = await ready();
    act(() => result.current.previewGrowthForCompletion('t1'));
    act(() => result.current.previewGrowthForCompletion('t1'));
    expect(result.current.treeState?.xp).toBe(110);
  });

  it('after sync the server answer REPLACES the preview: offline temp ids do not double-count', async () => {
    const { result } = await ready();
    act(() => result.current.previewGrowthForCompletion('local-1-abc')); // preview: 110

    act(() => result.current.applyServerGrowth(growth('srv-real-id', 110))); // server: 100 + 10

    expect(result.current.treeState?.xp).toBe(110); // not 120
    expect(result.current.treeState?.awardedTaskIds.has('srv-real-id')).toBe(true);
    expect(result.current.treeState?.awardedTaskIds.has('local-1-abc')).toBe(false);
  });

  it('a server answer lower than the preview wins (the preview was only a guess)', async () => {
    const { result } = await ready();
    act(() => result.current.previewGrowthForCompletion('a'));
    act(() => result.current.previewGrowthForCompletion('b')); // preview 120

    act(() => result.current.applyServerGrowth(growth('a', 110)));

    expect(result.current.treeState?.xp).toBe(110);
  });

  it('applyServerGrowth(undefined) is a no-op', async () => {
    const { result } = await ready();
    act(() => result.current.applyServerGrowth(undefined));
    expect(result.current.treeState?.xp).toBe(100);
  });
});
