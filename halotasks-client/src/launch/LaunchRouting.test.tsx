import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';

// Issue #49, phase 49C: what each route does with the launch decision. The real provider, readiness hook, auth store,
// guards, entry gate, sign-in page, waiting room and status line run; replaced are the health probe, IndexedDB and the
// layout's theme.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));
vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));
vi.mock('../App', () => ({ useTheme: () => ({ theme: 'midday' }) }));

import AppLayout from '../components/AppLayout';
import AuthEntryRoute from '../components/AuthEntryRoute';
import ProtectedRoute from '../components/ProtectedRoute';
import SmartEntryGate from '../components/SmartEntryGate';
import ForgotPasswordPage from '../pages/ForgotPasswordPage';
import LoginPage from '../pages/LoginPage';
import RegisterPage from '../pages/RegisterPage';
import ResetPasswordPage from '../pages/ResetPasswordPage';
import { useAuthStore } from '../store/authStore';
import { markKnownUser, markOnboardingDone } from '../utils/authSession';
import LaunchProvider from './LaunchProvider';
import { reportSessionAnswer } from './sessionAnswers';

const NOW = new Date('2026-11-13T10:00:00Z');
const b64 = (v: object) => btoa(JSON.stringify(v)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokenFor = (userId: string, expInSeconds = 3600) =>
  `${b64({ alg: 'HS256' })}.${b64({ userId, exp: Math.floor(NOW.getTime() / 1000) + expInSeconds })}.sig`;
const userOf = (id: string) => ({ id, name: id, email: `${id}@x.test` });

const trusted = (id = 'u1') => act(() => useAuthStore.getState().setAuth({ token: tokenFor(id), user: userOf(id) }));
/** A token the store holds with NO stored account: credentials that cannot be trusted without the server. */
const unverified = () => act(() => useAuthStore.setState({ token: tokenFor('u1'), user: null }));

const answers = (...results: HealthProbeResult[]) => {
  let call = 0;
  probe.mockImplementation(async () => results[Math.min(call++, results.length - 1)]);
};
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const SECRET = 'SECRET TASKS';
const tree = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <LaunchProvider>
        <Routes>
          <Route path="/" element={<SmartEntryGate />} />
          <Route path="/home" element={<p>landing page</p>} />
          <Route path="/login" element={<AuthEntryRoute><LoginPage /></AuthEntryRoute>} />
          <Route path="/register" element={<AuthEntryRoute onboardingAware><RegisterPage /></AuthEntryRoute>} />
          <Route path="/forgot-password" element={<AuthEntryRoute><ForgotPasswordPage /></AuthEntryRoute>} />
          <Route path="/reset-password" element={<AuthEntryRoute><ResetPasswordPage /></AuthEntryRoute>} />
          <Route
            path="/dashboard"
            element={
              <ProtectedRoute>
                <AppLayout>
                  <p>{SECRET}</p>
                </AppLayout>
              </ProtectedRoute>
            }
          />
          <Route path="/onboarding" element={<ProtectedRoute><p>ONBOARDING</p></ProtectedRoute>} />
        </Routes>
      </LaunchProvider>
    </MemoryRouter>,
  );

const waitingRoom = () => screen.queryByRole('region', { name: 'Waiting for the server' });
const hold = () => screen.queryByRole('region', { name: 'Checking your session' });
const secret = () => screen.queryByText(SECRET);
const loginForm = () => screen.queryByLabelText(/email address/i);
const offlineLine = () => screen.queryByText(/changes are saved on this device/);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  probe.mockReset();
  localStorage.clear();
  markOnboardingDone();
  useAuthStore.setState({ token: null, user: null, sessionGeneration: 0 });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a trusted session: the app is never behind the server', () => {
  it('server available: the app opens with no offline line, and is confirmed only by the server\'s own answer', async () => {
    await trusted();
    answers('ok');
    tree('/dashboard');
    await advance(0);
    expect(secret()).toBeInTheDocument();
    expect(offlineLine()).toBeNull();
    expect(waitingRoom()).toBeNull();
  });

  it('server unavailable: the app is there from the first render, then says honestly why it is offline (and nothing about sign-in)', async () => {
    await trusted();
    answers('no-answer');
    tree('/dashboard');
    expect(secret()).toBeInTheDocument(); // not blocked while the first probe is out
    await advance(5_000);
    expect(secret()).toBeInTheDocument();
    expect(offlineLine()).toBeInTheDocument();
    expect(screen.getByText(/server is waking up/i)).toBeInTheDocument();
    expect(screen.queryByText(/sign in/i)).toBeNull();

    await advance(100_000); // the wait ends in a failure: a different cause, the same app
    expect(secret()).toBeInTheDocument();
    expect(screen.getByText(/can't reach the server/i)).toBeInTheDocument();
  });

  it('"Check now" asks the shared probe again; the line disappears when the server is back, with no reload and the app never remounted', async () => {
    await trusted();
    answers('no-answer');
    tree('/dashboard');
    await advance(100_000);
    const before = probe.mock.calls.length;
    answers('ok');
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await advance(0);
    expect(probe.mock.calls.length).toBe(before + 1);
    expect(offlineLine()).toBeNull();
    expect(secret()).toBeInTheDocument();
  });

  it('a browser that is offline gets its own wording and no button that could not help', async () => {
    await trusted();
    answers('ok');
    tree('/dashboard');
    await advance(0);
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText(/You're offline/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
    act(() => {
      Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
      window.dispatchEvent(new Event('online'));
    });
  });

  it('offline never becomes "confirmed": only a server answer for this session does', async () => {
    await trusted();
    answers('no-answer');
    tree('/dashboard');
    await advance(100_000);
    expect(offlineLine()).toBeInTheDocument();
    // a server answer arriving for some other session changes nothing
    act(() => reportSessionAnswer({ sessionKey: tokenFor('someone-else'), verdict: 'valid' }));
    expect(offlineLine()).toBeInTheDocument();
  });
});

describe('a session that cannot be trusted without the server', () => {
  it('is held (nothing protected, nothing alarming) while the first probe is out, then gets the waiting room, never the app', async () => {
    await unverified();
    answers('no-answer');
    tree('/dashboard');
    expect(hold()).toBeInTheDocument();
    expect(secret()).toBeNull();
    expect(waitingRoom()).toBeNull();

    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server is waking up' })).toBeInTheDocument();
    expect(secret()).toBeNull();
    expect(hold()).toBeNull();
  });

  it('an expired or invalid local session with the server down is the waiting room too', async () => {
    act(() => useAuthStore.setState({ token: tokenFor('u1', -60), user: userOf('u1') }));
    answers('no-answer');
    tree('/dashboard');
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(secret()).toBeNull();
  });

  it('a stored account that is not the token\'s account is untrusted as well', async () => {
    act(() => useAuthStore.setState({ token: tokenFor('u1'), user: userOf('someone-else') }));
    answers('no-answer');
    tree('/dashboard');
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(secret()).toBeNull();
  });

  it('recovers by itself when the server comes back: no reload, and the app is NOT opened for a session the server never confirmed', async () => {
    await unverified();
    answers('no-answer', 'no-answer', 'ok');
    tree('/dashboard');
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    await advance(10_000);
    expect(waitingRoom()).toBeNull();
    expect(secret()).toBeNull();
    expect(loginForm()).toBeInTheDocument(); // the server cannot revive an unconfirmed session: sign in
  });

  it('with the server answering, an untrusted session goes to sign-in and does not bounce between the guard and the sign-in page', async () => {
    await unverified();
    answers('ok');
    tree('/dashboard');
    await advance(10_000);
    expect(loginForm()).toBeInTheDocument();
    expect(secret()).toBeNull();
    expect(probe.mock.calls.length).toBeLessThan(3); // no mount loop re-probing
  });

  it('"Check now" asks again immediately; "Play while you wait" opens the data-free game over an empty page', async () => {
    await unverified();
    answers('no-answer');
    tree('/dashboard');
    await advance(2_000);
    const before = probe.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await advance(0);
    expect(probe.mock.calls.length).toBe(before + 1);

    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    expect(screen.getByRole('dialog', { name: 'Server loading' })).toBeInTheDocument();
    expect(secret()).toBeNull();
  });

  it('closing the game with Escape puts focus back on "Play while you wait"', async () => {
    await unverified();
    answers('no-answer');
    tree('/dashboard');
    await advance(2_000);
    const play = screen.getByRole('button', { name: 'Play while you wait' });
    fireEvent.click(play);
    const dialog = screen.getByRole('dialog', { name: 'Server loading' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await advance(1_500);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play while you wait' }));
  });

  it('signing out while waiting leaves a correct signed-out state, not the waiting room', async () => {
    await unverified();
    answers('no-answer');
    tree('/dashboard');
    await advance(2_000);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    await advance(0);
    expect(useAuthStore.getState().token).toBeNull();
    expect(waitingRoom()).toBeNull();
    expect(loginForm()).toBeInTheDocument();
  });

  it('a refresh (a new mount of the whole app) while the server is down lands in the same place and starts checking again', async () => {
    await unverified();
    answers('no-answer');
    const first = tree('/dashboard');
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    first.unmount();
    probe.mockClear();

    tree('/dashboard');
    expect(hold()).toBeInTheDocument();
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(probe).toHaveBeenCalled();
    expect(secret()).toBeNull();
  });

  it('keeps the waiting room bounded: ten minutes of a dead server is a handful of requests', async () => {
    await unverified();
    answers('no-answer');
    tree('/dashboard');
    await advance(10 * 60_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(probe.mock.calls.length).toBeLessThan(40);
  });
});

describe('direct navigation', () => {
  it('"/" with an untrusted session reaches the same waiting room as "/dashboard"', async () => {
    await unverified();
    answers('no-answer');
    tree('/');
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(secret()).toBeNull();
  });

  it('"/" with a trusted session opens the app even while the server is down', async () => {
    await trusted();
    answers('no-answer');
    tree('/');
    await advance(5_000);
    expect(secret()).toBeInTheDocument();
  });

  it('"/login" while the server is down is the sign-in page with its warm-up (the issue #12 experience), not the waiting room', async () => {
    answers('no-answer');
    tree('/login');
    await advance(2_000);
    expect(loginForm()).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Server loading' })).toBeInTheDocument();
    expect(waitingRoom()).toBeNull();
  });

  it('a signed-in, trusted visitor of "/login" is sent to the app (as before), even with the server down', async () => {
    await trusted();
    answers('no-answer');
    tree('/login');
    await advance(5_000);
    expect(secret()).toBeInTheDocument();
  });

  it('an anonymous first visit asks the server nothing: no probe for the landing page', async () => {
    answers('ok');
    tree('/');
    await advance(60_000);
    expect(screen.getByText('landing page')).toBeInTheDocument();
    expect(probe).not.toHaveBeenCalled();
  });

  it('a returning anonymous visitor goes to sign-in, which does probe', async () => {
    markKnownUser();
    answers('ok');
    tree('/');
    await advance(0);
    expect(loginForm()).toBeInTheDocument();
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('the public sign-in routes obey the same contract as the protected ones', () => {
  const AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

  it.each(AUTH_PATHS)('unverified + server unavailable: %s is the waiting room, never a form', async (path) => {
    await unverified();
    answers('no-answer');
    tree(path);
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    expect(loginForm()).toBeNull();
    expect(screen.queryByRole('button', { name: /send reset code|create account|sign in/i })).toBeNull();
    expect(secret()).toBeNull();
  });

  it.each(AUTH_PATHS)('unverified + still checking: %s is the quiet hold', async (path) => {
    await unverified();
    answers('no-answer');
    tree(path);
    expect(hold()).toBeInTheDocument();
    expect(loginForm()).toBeNull();
  });

  it.each(['/login', '/forgot-password', '/reset-password'])('trusted + server unavailable: %s goes to the app', async (path) => {
    await trusted();
    answers('no-answer');
    tree(path);
    await advance(5_000);
    expect(secret()).toBeInTheDocument();
    expect(offlineLine()).toBeInTheDocument();
  });

  it('trusted at /register goes to onboarding the first time and to the app afterwards', async () => {
    await trusted();
    answers('ok');
    localStorage.removeItem('halotasks_onboarding_done');
    const first = tree('/register');
    await advance(0);
    expect(screen.getByText('ONBOARDING')).toBeInTheDocument();
    first.unmount();

    markOnboardingDone();
    tree('/register');
    await advance(0);
    expect(secret()).toBeInTheDocument();
    expect(screen.queryByText('ONBOARDING')).toBeNull();
  });

  it.each(AUTH_PATHS)('anonymous: %s stays the page it is', async (path) => {
    answers('ok');
    tree(path);
    await advance(0);
    expect(waitingRoom()).toBeNull();
    expect(hold()).toBeNull();
    expect(secret()).toBeNull();
    expect(screen.getByRole('region', { name: /sign in|create|reset|forgot/i })).toBeInTheDocument();
  });

  it('unverified, waiting at /login, the server recovering moves to the sign-in form by itself', async () => {
    await unverified();
    answers('no-answer', 'no-answer', 'ok');
    tree('/login');
    await advance(2_000);
    expect(waitingRoom()).toBeInTheDocument();
    await advance(10_000);
    expect(waitingRoom()).toBeNull();
    expect(loginForm()).toBeInTheDocument();
  });

  it('a session the server has confirmed is in the app from the sign-in route', async () => {
    await trusted();
    answers('ok');
    tree('/login');
    await advance(0);
    expect(secret()).toBeInTheDocument();
    expect(loginForm()).toBeNull();
  });
});
