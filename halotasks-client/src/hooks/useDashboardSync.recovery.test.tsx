import { act, render, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';

// Issue #49, 49C: when the server comes back after being unavailable, the dashboard re-syncs by itself through the
// existing load (queue first, then a fresh read), and never loads twice just because it opened.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));
vi.mock('../offline/cache', () => ({
  getCachedTasks: vi.fn(async () => []),
  getLastSyncTimestamp: vi.fn(async () => null),
  setCachedTasks: vi.fn(async () => undefined),
  setLastSyncTimestamp: vi.fn(async () => undefined),
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));
vi.mock('../offline/queueProcessor', () => ({
  processSyncQueue: vi.fn(async () => ({ processed: 0, failed: 0, remaining: 0 })),
}));
vi.mock('../offline/syncQueue', () => ({ getSyncQueue: vi.fn(async () => []) }));
vi.mock('../services/taskService', () => ({ taskService: { getTasks: vi.fn() } }));

import LaunchProvider from '../launch/LaunchProvider';
import { reportServerTrouble } from '../launch/serverTrouble';
import { taskService } from '../services/taskService';
import { useAuthStore } from '../store/authStore';
import { useDashboardSync } from './useDashboardSync';
import { useState } from 'react';

const NOW = new Date('2026-11-13T10:00:00Z');
const b64 = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64({ alg: 'HS256' })}.${b64({ userId: 'u1', exp: Math.floor(NOW.getTime() / 1000) + 3600 })}.sig`;

const answers = (...results: HealthProbeResult[]) => {
  let call = 0;
  probe.mockImplementation(async () => results[Math.min(call++, results.length - 1)]);
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/dashboard']}>
    <LaunchProvider>{children}</LaunchProvider>
  </MemoryRouter>
);
const mountSync = () =>
  renderHook(
    () =>
      useDashboardSync({
        isOnline: true,
        persistTasks: vi.fn(),
        setLoadingTasks: vi.fn(),
        setStatusError: vi.fn(),
        setStatusInfo: vi.fn(),
        setTasks: vi.fn(),
      }),
    { wrapper },
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  probe.mockReset();
  vi.mocked(taskService.getTasks).mockReset();
  vi.mocked(taskService.getTasks).mockResolvedValue({ tasks: [] } as never);
  act(() => useAuthStore.getState().setAuth({ token, user: { id: 'u1', name: 'u1', email: 'u1@x.test' } }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('dashboard recovery after the server was unavailable', () => {
  it('opening the dashboard loads once, even though the readiness answer arrives afterwards', async () => {
    answers('ok');
    mountSync();
    await advance(5_000);
    expect(taskService.getTasks).toHaveBeenCalledTimes(1);
  });

  it('the server coming back re-syncs once, with no click and no reload', async () => {
    answers('no-answer');
    mountSync();
    await advance(100_000);
    const loadsWhileDown = vi.mocked(taskService.getTasks).mock.calls.length;

    answers('ok');
    await advance(35_000); // the slow background re-check finds it
    expect(taskService.getTasks).toHaveBeenCalledTimes(loadsWhileDown + 1);
    await advance(5 * 60_000);
    expect(taskService.getTasks).toHaveBeenCalledTimes(loadsWhileDown + 1); // and stops there
  });

  it('a brief failed request that the probe finds healthy does not trigger a pointless re-sync', async () => {
    answers('ok');
    mountSync();
    await advance(1_000);
    const loads = vi.mocked(taskService.getTasks).mock.calls.length;
    act(() => reportServerTrouble());
    await advance(5_000);
    expect(taskService.getTasks).toHaveBeenCalledTimes(loads);
  });
});

describe('a dashboard that opens after a recovery already happened', () => {
  it('does not treat that old recovery as its own: it loads once when it opens', async () => {
    const Sync = () => {
      useDashboardSync({
        isOnline: true,
        persistTasks: vi.fn(),
        setLoadingTasks: vi.fn(),
        setStatusError: vi.fn(),
        setStatusInfo: vi.fn(),
        setTasks: vi.fn(),
      });
      return null;
    };
    let open: () => void = () => undefined;
    const Late = () => {
      const [shown, setShown] = useState(false);
      open = () => setShown(true);
      return shown ? <Sync /> : null;
    };

    answers('no-answer');
    render(<MemoryRouter initialEntries={['/dashboard']}><LaunchProvider><Late /></LaunchProvider></MemoryRouter>);
    await advance(100_000);
    answers('ok');
    await advance(35_000); // one recovery has happened; no dashboard was open
    expect(taskService.getTasks).not.toHaveBeenCalled();

    act(() => open());
    await advance(1_000);
    expect(taskService.getTasks).toHaveBeenCalledTimes(1);
  });
});
