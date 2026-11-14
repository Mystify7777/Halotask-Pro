import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import axios from 'axios';
import { useEffect, type ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';

// Issue #49, phase 49B: the provider lifecycle. The real provider, readiness hook, auth store, API client interceptors and
// BackendWarmup run; replaced are only the health probe, IndexedDB and the redirect seam.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));
vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

import BackendWarmup from '../components/BackendWarmup';
import { WAKE_BUDGET_MS } from '../hooks/useBackendReadiness';
import { apiClient, authRedirect } from '../services/api';
import { useAuthStore } from '../store/authStore';
import LaunchProvider from './LaunchProvider';
import { useLaunch } from './launchContext';
import { reportSessionAnswer, subscribeSessionAnswers } from './sessionAnswers';
import { TROUBLE_RECHECK_MIN_GAP_MS, reportServerTrouble } from './serverTrouble';

const NOW = new Date('2026-11-13T10:00:00Z');
const b64 = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokenFor = (userId: string, expInSeconds = 3600, nonce = '') =>
  `${b64({ alg: 'HS256' })}.${b64({ userId, nonce, exp: Math.floor(NOW.getTime() / 1000) + expInSeconds })}.sig`;
const userOf = (id: string) => ({ id, name: id, email: `${id}@x.test` });

const signIn = (id: string, token = tokenFor(id), user = userOf(id)) => act(() => useAuthStore.getState().setAuth({ token, user }));
const signOut = () => act(() => useAuthStore.getState().clearAuth());
const answer = (sessionKey: string, verdict: 'valid' | 'invalid') => act(() => reportSessionAnswer({ sessionKey, verdict }));

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
const inApp = (ui: ReactNode, path = '/dashboard') => render(<MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>);
const mount = () => renderHook(() => useLaunch(), { wrapper });
const stateOf = (r: { current: ReturnType<typeof useLaunch> }) => `${r.current.decision.state}/${r.current.decision.access}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: gaps are exactly the base values
  probe.mockReset();
  localStorage.clear();
  useAuthStore.setState({ token: null, user: null, sessionGeneration: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the decision, through the real provider', () => {
  it('a trusted session is never held: checking-server keeps the app, then revalidating, then normal-online on the server\'s answer', async () => {
    await signIn('u1');
    probe.mockImplementation(() => new Promise<HealthProbeResult>(() => undefined));
    const { result } = mount();
    expect(stateOf(result)).toBe('checking-server/app');

    answers('ok');
    await advance(10_000);
    // a first run of the mount above is still pending; remount with an answer
    const second = mount();
    await advance(0);
    expect(stateOf(second.result)).toBe('revalidating/app');
    await answer(tokenFor('u1'), 'valid');
    expect(stateOf(second.result)).toBe('normal-online/app');
  });

  it('an untrusted session is held while checking, and gets the waiting room (never the app) when the server is down', async () => {
    await signIn('u1');
    act(() => useAuthStore.setState({ user: null })); // a token with no stored account
    answers('no-answer');
    const { result } = mount();
    expect(stateOf(result)).toBe('checking-server/hold');
    await advance(2_000);
    expect(stateOf(result)).toBe('waiting-room/waiting-room');
    expect(result.current.decision.unverified).toBe('no-stored-user');
  });

  it('trusted + server down is offline-capable with the cause, and the app is never blocked on the way', async () => {
    await signIn('u1');
    answers('no-answer');
    const { result } = mount();
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      await advance(1_000);
      seen.add(stateOf(result));
    }
    expect(seen).toContain('offline-capable/app');
    for (const s of seen) expect(s.endsWith('/app')).toBe(true);
    expect(result.current.decision.unavailable).toBe('waking');
  });

  it('a browser that is offline is offline-capable with its own cause', async () => {
    await signIn('u1');
    answers('ok');
    const { result } = mount();
    await advance(0);
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    expect(stateOf(result)).toBe('offline-capable/app');
    expect(result.current.decision.unavailable).toBe('browser-offline');
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
    await advance(0);
    expect(stateOf(result)).toBe('revalidating/app');
  });
});

describe('recovery without a reload or a remount', () => {
  const Probe = ({ onMount }: { onMount: () => void }) => {
    const { decision } = useLaunch();
    useEffect(onMount, []); // eslint-disable-line react-hooks/exhaustive-deps
    return <p data-testid="s">{`${decision.state}/${decision.access}`}</p>;
  };

  it('the server coming back moves offline-capable to revalidating on its own, and the app subtree is mounted exactly once', async () => {
    await signIn('u1');
    const mounted = vi.fn();
    answers('no-answer');
    inApp(<LaunchProvider><Probe onMount={mounted} /></LaunchProvider>);
    await advance(WAKE_BUDGET_MS + 30_000);
    expect(screen.getByTestId('s').textContent).toBe('offline-capable/app');

    answers('ok');
    await advance(35_000); // the slow background re-check
    expect(screen.getByTestId('s').textContent).toBe('revalidating/app');
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it('is bounded: ten minutes of a dead server is a handful of requests, not a storm', async () => {
    await signIn('u1');
    answers('no-answer');
    mount();
    await advance(10 * 60_000);
    expect(probe.mock.calls.length).toBeGreaterThan(10);
    expect(probe.mock.calls.length).toBeLessThan(40);
  });

  it('the gaps grow: nothing is probed before the first backoff gap, then 3.2 s, ...', async () => {
    await signIn('u1');
    answers('no-answer');
    mount();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(1_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(3_199);
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('unmounting stops all probing', async () => {
    await signIn('u1');
    answers('no-answer');
    const { unmount } = mount();
    await advance(5_000);
    unmount();
    const calls = probe.mock.calls.length;
    await advance(10 * 60_000);
    expect(probe).toHaveBeenCalledTimes(calls);
  });
});

describe('the verdict belongs to one session', () => {
  const ready = async () => {
    answers('ok');
    const hook = mount();
    await advance(0);
    return hook;
  };

  it('A confirmed, A signs out, B signs in: B does not inherit it', async () => {
    await signIn('a');
    const { result } = await ready();
    await answer(tokenFor('a'), 'valid');
    expect(stateOf(result)).toBe('normal-online/app');
    await signOut();
    expect(stateOf(result)).toBe('auth-flow/login');
    await signIn('b');
    expect(stateOf(result)).toBe('revalidating/app');
  });

  it('A rejected, B signs in: B is not rejected', async () => {
    await signIn('a');
    const { result } = await ready();
    await answer(tokenFor('a'), 'invalid');
    expect(stateOf(result)).toBe('auth-flow/login');
    await signOut();
    await signIn('b');
    expect(stateOf(result)).toBe('revalidating/app');
  });

  it('a late answer for A after B signed in changes nothing, valid or invalid', async () => {
    await signIn('a');
    const { result } = await ready();
    await signOut();
    await signIn('b');
    await answer(tokenFor('a'), 'invalid');
    expect(stateOf(result)).toBe('revalidating/app');
    await answer(tokenFor('a'), 'valid');
    expect(stateOf(result)).toBe('revalidating/app');
    await answer(tokenFor('b'), 'valid');
    expect(stateOf(result)).toBe('normal-online/app');
  });

  it('signing in again with the very same token does not keep the old verdict (a new session instance)', async () => {
    const token = tokenFor('a');
    await signIn('a', token);
    const { result } = await ready();
    await answer(token, 'valid');
    expect(stateOf(result)).toBe('normal-online/app');
    await signIn('a', token);
    expect(stateOf(result)).toBe('revalidating/app');
  });

  it('a rejection is final for its session: a late success cannot undo it', async () => {
    await signIn('a');
    const { result } = await ready();
    await answer(tokenFor('a'), 'invalid');
    await answer(tokenFor('a'), 'valid');
    expect(stateOf(result)).toBe('auth-flow/login');
  });

  it('a rejected token that signs in again as a new session instance can be confirmed by the server (the rejection was for the old instance)', async () => {
    const token = tokenFor('a');
    await signIn('a', token);
    const { result } = await ready();
    await answer(token, 'invalid');
    await signOut();
    await signIn('a', token);
    expect(stateOf(result)).toBe('revalidating/app');
    await answer(token, 'valid');
    expect(stateOf(result)).toBe('normal-online/app');
  });

  it('a verdict does not survive a sign-out even though the key is gone', async () => {
    await signIn('a');
    const { result } = await ready();
    await answer(tokenFor('a'), 'valid');
    await signOut();
    await answer(tokenFor('a'), 'valid'); // no current session: ignored
    await signIn('c');
    expect(stateOf(result)).toBe('revalidating/app');
  });
});

describe('a trusted session stops being trusted when its token expires', () => {
  it('server ready: expiry sends the user to sign in', async () => {
    await signIn('a', tokenFor('a', 60));
    answers('ok');
    const { result } = mount();
    await advance(0);
    await answer(tokenFor('a', 60), 'valid');
    expect(stateOf(result)).toBe('normal-online/app');
    await advance(61_000);
    expect(stateOf(result)).toBe('auth-flow/login');
  });

  it('server down: expiry moves the app to the waiting room', async () => {
    await signIn('a', tokenFor('a', 60));
    answers('no-answer');
    const { result } = mount();
    await advance(30_000);
    expect(stateOf(result)).toBe('offline-capable/app');
    await advance(31_000);
    expect(stateOf(result)).toBe('waiting-room/waiting-room');
    expect(result.current.decision.unverified).toBe('expired-or-malformed');
  });
});

describe('one probe for the whole app', () => {
  it('the sign-in warm-up shows the provider\'s answer instead of starting a second probe', async () => {
    answers('no-answer');
    inApp(<LaunchProvider><BackendWarmup /></LaunchProvider>, '/login'); // signed out: only a sign-in page probes
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(WAKE_BUDGET_MS + 20_000);
    const failure = screen.getByTestId('backend-warmup-failure');
    expect(failure.getAttribute('data-reason')).toBe('timeout');

    const before = probe.mock.calls.length;
    answers('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await advance(0);
    expect(probe.mock.calls.length).toBe(before + 1); // the provider's retry, not a second hook
    expect(screen.queryByTestId('backend-warmup-failure')).toBeNull();
  });
});

describe('the API client is the only source of verdicts', () => {
  const replyWith = (status: number) =>
    vi.fn(async (config: never) => {
      if (status >= 400) {
        throw new axios.AxiosError('fail', 'ERR_BAD_REQUEST', config, null, { status, statusText: '', headers: {}, config, data: {} } as never);
      }
      return { data: {}, status, statusText: '', headers: {}, config };
    });
  const mountReady = async () => {
    answers('ok');
    const hook = mount();
    await advance(0);
    return hook;
  };

  beforeEach(() => {
    vi.spyOn(authRedirect, 'toLogin').mockImplementation(() => undefined);
  });

  it('a successful authenticated call confirms the session', async () => {
    await signIn('a');
    const { result } = await mountReady();
    apiClient.defaults.adapter = replyWith(200) as never;
    await act(async () => { await apiClient.get('/api/tasks'); });
    expect(stateOf(result)).toBe('normal-online/app');
  });

  it('sign-in and other public auth calls never report an answer, even with a session token attached', async () => {
    await signIn('a');
    await mountReady();
    const heard = vi.fn();
    const off = subscribeSessionAnswers(heard);
    apiClient.defaults.adapter = replyWith(200) as never;
    await act(async () => { await apiClient.post('/api/auth/login', {}); });
    apiClient.defaults.adapter = replyWith(401) as never;
    await act(async () => { await apiClient.post('/api/auth/login', {}).catch(() => undefined); });
    off();
    expect(heard).not.toHaveBeenCalled();
  });

  it('a call made with no session reports nothing and confirms nothing', async () => {
    const { result } = await mountReady();
    const heard = vi.fn();
    const off = subscribeSessionAnswers(heard);
    apiClient.defaults.adapter = replyWith(200) as never;
    await act(async () => { await apiClient.get('/api/tasks'); });
    off();
    expect(heard).not.toHaveBeenCalled();
    expect(stateOf(result)).toBe('auth-flow/login');
  });

  it('a 401 is reported as a rejection of the token it was sent with, and ends the session', async () => {
    await signIn('a');
    const { result } = await mountReady();
    const heard = vi.fn();
    const off = subscribeSessionAnswers(heard);
    apiClient.defaults.adapter = replyWith(401) as never;
    await act(async () => { await apiClient.get('/api/tasks').catch(() => undefined); });
    off();
    expect(heard).toHaveBeenCalledWith({ sessionKey: tokenFor('a'), verdict: 'invalid' });
    expect(stateOf(result)).toBe('auth-flow/login');
  });

  it('a late 401 for A, arriving after B signed in, does not touch B', async () => {
    await signIn('a');
    const { result } = await mountReady();
    let release: () => void = () => undefined;
    apiClient.defaults.adapter = (async (config: never) => {
      await new Promise<void>((r) => { release = r; });
      throw new axios.AxiosError('fail', 'ERR_BAD_REQUEST', config, null, { status: 401, statusText: '', headers: {}, config, data: {} } as never);
    }) as never;
    const inFlight = apiClient.get('/api/tasks').catch(() => undefined);
    await signOut();
    await signIn('b');
    await act(async () => { release(); await inFlight; });
    expect(useAuthStore.getState().user?.id).toBe('b');
    expect(stateOf(result)).toBe('revalidating/app');
  });
});

describe('mid-session server loss: a failed request only asks, the probe decides (49C)', () => {
  const trouble = () => act(() => reportServerTrouble());
  const readyAndConfirmed = async () => {
    await signIn('a');
    answers('ok');
    const hook = mount();
    await advance(0);
    await answer(tokenFor('a'), 'valid');
    probe.mockClear();
    return hook;
  };

  it('one failure asks for one fresh probe; a healthy answer changes nothing the user can see and counts as no recovery', async () => {
    const { result } = await readyAndConfirmed();
    const seen = new Set<string>();
    trouble();
    for (let i = 0; i < 5; i++) {
      await advance(500);
      seen.add(stateOf(result));
    }
    expect(probe).toHaveBeenCalledTimes(1);
    expect(stateOf(result)).toBe('normal-online/app');
    expect([...seen].every((s) => s.endsWith('/app'))).toBe(true);
    expect(seen.has('offline-capable/app')).toBe(false);
    expect(result.current.serverRecoveries).toBe(0);
  });

  it('a burst of failures is still one probe, and the next one is allowed only after the minimum gap', async () => {
    await readyAndConfirmed();
    for (let i = 0; i < 50; i++) trouble();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(TROUBLE_RECHECK_MIN_GAP_MS - 1_000);
    trouble();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(1_000);
    trouble();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('when the probe fails too, the app goes offline-capable (still the app), and the server coming back is exactly one recovery', async () => {
    const { result } = await readyAndConfirmed();
    answers('no-answer');
    trouble();
    await advance(3_000);
    expect(stateOf(result)).toBe('offline-capable/app');
    expect(result.current.serverRecoveries).toBe(0);

    answers('ok');
    await advance(150_000);
    expect(result.current.decision.state).toBe('normal-online'); // the earlier confirmation still holds for this session
    expect(result.current.serverRecoveries).toBe(1);
  });

  it('is ignored while the server is already known to be unavailable', async () => {
    await signIn('a');
    answers('no-answer');
    const { result } = mount();
    await advance(3_000);
    const calls = probe.mock.calls.length;
    trouble();
    await advance(0);
    expect(probe.mock.calls.length).toBe(calls);
    expect(result.current.decision.state).toBe('offline-capable');
  });

  it('"Check now" after a failed wait that then succeeds is a recovery', async () => {
    await signIn('a');
    answers('no-answer');
    const { result } = mount();
    await advance(100_000);
    answers('ok');
    act(() => result.current.readiness.retry());
    await advance(0);
    expect(result.current.serverRecoveries).toBe(1);
  });
});

describe('the API client tells the provider about unreachable servers (49C)', () => {
  const failWith = (init: { code?: string; status?: number }) =>
    vi.fn(async (config: never) => {
      throw new axios.AxiosError(
        'fail',
        init.code,
        config,
        null,
        init.status ? ({ status: init.status, statusText: '', headers: {}, config, data: {} } as never) : undefined,
      );
    });
  const probesAfter = async (call: () => Promise<unknown>) => {
    await signIn('a');
    answers('ok');
    mount();
    await advance(0);
    probe.mockClear();
    await act(async () => { await call().catch(() => undefined); });
    await advance(0);
    return probe.mock.calls.length;
  };

  beforeEach(() => {
    vi.spyOn(authRedirect, 'toLogin').mockImplementation(() => undefined);
  });

  it.each([
    ['a network error', { code: 'ERR_NETWORK' }],
    ['a timeout', { code: 'ECONNABORTED' }],
    ['a 502', { status: 502 }],
    ['a 503', { status: 503 }],
    ['a 504', { status: 504 }],
  ])('%s on an authenticated request asks for one probe', async (_name, init) => {
    apiClient.defaults.adapter = failWith(init) as never;
    expect(await probesAfter(() => apiClient.get('/api/tasks'))).toBe(1);
  });

  it.each([
    ['a 400', { status: 400 }],
    ['a 404', { status: 404 }],
    ['a 409', { status: 409 }],
    ['a 500', { status: 500 }],
    ['a cancelled request', { code: 'ERR_CANCELED' }],
  ])('%s is the server speaking (or the app cancelling): no probe', async (_name, init) => {
    apiClient.defaults.adapter = failWith(init) as never;
    expect(await probesAfter(() => apiClient.get('/api/tasks'))).toBe(0);
  });

  it('a public sign-in call that cannot reach the server is not session trouble', async () => {
    apiClient.defaults.adapter = failWith({ code: 'ERR_NETWORK' }) as never;
    expect(await probesAfter(() => apiClient.post('/api/auth/login', {}))).toBe(0);
  });
});
