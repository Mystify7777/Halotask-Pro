import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';

// The cold-start game and the working dashboard (the audit in claude/audit-cold-start-game.md). The invariant: entering the
// waiting / cold-start state never by itself makes the game visible; only "Play while you wait" does. The REAL DashboardPage
// runs inside the real LaunchProvider, ProtectedRoute and AppLayout (which hosts the status line), so an automatic trigger
// added anywhere on that path (an effect in the page, a timer in a hook) shows up here. Replaced: the health probe, the task
// API and the IndexedDB-backed modules.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
const api = vi.hoisted(() => ({
  getTasks: vi.fn(),
  processSyncQueue: vi.fn(),
}));
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));
vi.mock('../services/taskService', () => ({
  taskService: new Proxy({ getTasks: api.getTasks } as Record<string, unknown>, {
    get: (target, key: string) => (key in target ? target[key] : vi.fn(async () => ({}))),
  }),
}));
vi.mock('../offline/cache', () => ({
  getCachedTasks: vi.fn(async () => []),
  getLastSyncTimestamp: vi.fn(async () => null),
  setCachedTasks: vi.fn(async () => {}),
  setLastSyncTimestamp: vi.fn(async () => {}),
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));
vi.mock('../offline/queueProcessor', () => ({ processSyncQueue: api.processSyncQueue }));
vi.mock('../offline/syncQueue', () => ({ getSyncQueue: vi.fn(async () => []), enqueueSyncAction: vi.fn(async () => {}) }));
vi.mock('../offline/completionEvents', () => ({
  enqueueCompletion: vi.fn(async () => {}),
  makeCompletionTransition: vi.fn(),
}));
vi.mock('../offline/history', () => ({
  getWeekHistory: vi.fn(async () => []),
  requestHistoryReconcile: vi.fn(async () => {}),
  updateTodaySnapshot: vi.fn(async () => {}),
}));
vi.mock('../growth/treeStorage', () => ({
  initTreeStorage: vi.fn(async () => ({ streakDays: 0, lastActiveDate: null, xp: 0 })),
  getTreeState: vi.fn(() => ({ streakDays: 0, lastActiveDate: null, xp: 0 })),
  applyServerGrowth: vi.fn(),
  TreeIdentityError: class extends Error {},
}));
vi.mock('../hooks/usePushSubscription', () => ({
  registerSW: vi.fn(async () => null),
  subscribePush: vi.fn(async () => null),
  relayToServer: vi.fn(async () => {}),
}));
vi.mock('../App', () => ({ useTheme: () => ({ theme: 'midday' }) }));

import AppLayout from '../components/AppLayout';
import ProtectedRoute from '../components/ProtectedRoute';
import LaunchProvider from '../launch/LaunchProvider';
import { useAuthStore } from '../store/authStore';
import { markOnboardingDone } from '../utils/authSession';
import DashboardPage from './DashboardPage';

const NOW = new Date('2026-11-13T10:00:00Z');
const b64 = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const token = `${b64({ alg: 'HS256' })}.${b64({ userId: 'u1', exp: Math.floor(NOW.getTime() / 1000) + 3600 })}.sig`;

const answers = (...results: HealthProbeResult[]) => {
  let call = 0;
  probe.mockImplementation(async () => results[Math.min(call++, results.length - 1)]);
};
/** The server is down until the test brings it back: recovery happens exactly when the test says so. */
const server = { up: false };
const useSwitchableServer = () => {
  server.up = false;
  probe.mockImplementation(async () => (server.up ? 'ok' : 'no-answer'));
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const dialog = () => screen.queryByRole('dialog', { name: 'Server loading' });
const playButton = () => screen.queryByRole('button', { name: 'Play while you wait' });
const waking = () => screen.queryByText(/The server is waking up/);

/** A request that never answers until the test lets it. */
const hang = () => new Promise<never>(() => {});

const mount = () =>
  render(
    <MemoryRouter initialEntries={['/dashboard']}>
      <LaunchProvider>
        <Routes>
          <Route path="/dashboard" element={<ProtectedRoute><AppLayout><DashboardPage /></AppLayout></ProtectedRoute>} />
        </Routes>
      </LaunchProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  probe.mockReset();
  api.getTasks.mockReset();
  api.processSyncQueue.mockReset();
  api.processSyncQueue.mockResolvedValue({ processed: 0, failed: 0, remaining: 0 });
  api.getTasks.mockImplementation(hang);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
  localStorage.clear();
  markOnboardingDone();
  useAuthStore.setState({ token, user: { id: 'u1', name: 'u1', email: 'u1@x.test' }, sessionGeneration: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the working dashboard never opens the game by itself', () => {
  it('server unavailable and the task request unanswered: the status line says so, and no dialog appears at 3 s, 10 s or a minute', async () => {
    answers('no-answer');
    mount();
    for (const ms of [1_000, 2_500, 7_000, 50_000]) {
      await advance(ms);
      expect(dialog()).toBeNull();
    }
    expect(waking()).toBeInTheDocument(); // the calm status line is there, the modal is not
    expect(playButton()).toBeInTheDocument();
    expect(api.getTasks).toHaveBeenCalled(); // the page really was loading tasks all that time
  });

  it('the server recovers while the task request is still slow: the recovery reload runs and still no dialog appears', async () => {
    useSwitchableServer();
    mount();
    await advance(20_000);
    expect(waking()).toBeInTheDocument();
    const callsBefore = api.getTasks.mock.calls.length;
    server.up = true;
    await advance(60_000);
    expect(waking()).toBeNull(); // recovered
    expect(api.getTasks.mock.calls.length).toBeGreaterThan(callsBefore); // the reload that used to restart a 3 s overlay timer
    expect(dialog()).toBeNull();
  });

  it('a healthy server with a slow sync queue is just a sync in progress, never a game', async () => {
    answers('ok');
    api.processSyncQueue.mockImplementation(hang);
    mount();
    await advance(60_000);
    expect(dialog()).toBeNull();
    expect(playButton()).toBeNull(); // nothing is wrong with the server, so nothing offers a game either
  });

  it('"Play while you wait" opens it; Escape closes it and puts focus back on the button; it does not come back by itself', async () => {
    answers('no-answer');
    mount();
    await advance(5_000);
    fireEvent.click(playButton()!);
    expect(dialog()).toBeInTheDocument();
    fireEvent.keyDown(dialog()!, { key: 'Escape' });
    await advance(1_500);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(playButton());
    await advance(120_000); // probe cycles, the 90 s wake budget ending, background re-checks
    expect(dialog()).toBeNull();
  });

  it('a game the person closed does not reopen when the server then recovers and the reload is slow', async () => {
    useSwitchableServer();
    mount();
    await advance(3_000);
    fireEvent.click(playButton()!);
    fireEvent.keyDown(dialog()!, { key: 'Escape' });
    await advance(1_500);
    server.up = true;
    await advance(60_000);
    expect(waking()).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('a game that is open when the server recovers closes itself with the "ready" beat, and is not reopened by the reload', async () => {
    useSwitchableServer();
    mount();
    await advance(3_000);
    fireEvent.click(playButton()!);
    expect(dialog()).toBeInTheDocument();
    expect(screen.queryByText(/Server is ready/)).toBeNull();
    await advance(10_000); // still down: the game stays open, nothing claims "ready"
    expect(dialog()).toBeInTheDocument();
    expect(screen.queryByText(/Server is ready/)).toBeNull();
    server.up = true;
    // keep advancing until the shared probe answers: the "ready" beat is shown (briefly) and then the game is gone
    let sawReady = false;
    for (let i = 0; i < 80 && (dialog() || !sawReady); i += 1) {
      await advance(500);
      if (screen.queryByText(/Server is ready/)) sawReady = true;
      if (sawReady && !dialog()) break;
    }
    expect(sawReady).toBe(true);
    await advance(5_000);
    expect(dialog()).toBeNull();
    await advance(60_000); // the recovery reload is still pending: it must not bring the game back
    expect(dialog()).toBeNull();
  });
});
