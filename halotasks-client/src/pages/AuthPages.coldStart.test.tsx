import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';

// Issue #12 (changed by the "game opens only on request" follow-up): the login and register pages get the cold-start
// notice BEFORE anyone is signed in; the game opens only from its button. The real pages, the
// real warm-up component, hook and overlay run; replaced are only the readiness probe, the auth network calls and
// IndexedDB.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));
vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));
vi.mock('../services/authService', () => ({
  authService: { login: vi.fn(), register: vi.fn(), forgotPassword: vi.fn(), resetPassword: vi.fn() },
}));

import { apiClient } from '../services/api';
import { authService } from '../services/authService';
import { FIXED_PACING } from '../hooks/useBackendReadiness';
import LaunchProvider from '../launch/LaunchProvider';
import { useAuthStore } from '../store/authStore';
import LoginPage from './LoginPage';
import RegisterPage from './RegisterPage';
import ResetPasswordPage from './ResetPasswordPage';

const answers = (...results: HealthProbeResult[]) => {
  let call = 0;
  probe.mockImplementation(async () => results[Math.min(call++, results.length - 1)]);
};
const pending = () => probe.mockImplementation(() => new Promise<HealthProbeResult>(() => undefined));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const finishClose = async () => {
  await advance(900);
  await advance(500);
};
const overlay = () => screen.queryByRole('dialog', { name: 'Server loading' });
const waking = () => screen.queryByTestId('backend-warmup-waking');

const renderAt = (path: '/login' | '/register' | '/reset-password') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      {/* The app always has the launch provider; FIXED_PACING keeps these Issue #12 expectations on their original timing. */}
      <LaunchProvider pacing={FIXED_PACING}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/dashboard" element={<p>dashboard reached</p>} />
          <Route path="/onboarding" element={<p>onboarding reached</p>} />
          <Route path="/home" element={<p>home</p>} />
        </Routes>
      </LaunchProvider>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.useFakeTimers();
  probe.mockReset();
  vi.mocked(authService.login).mockReset();
  useAuthStore.setState({ token: null, user: null });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(['/login', '/register'] as const)('%s, reached directly while signed out', (path) => {
  it('says the server is waking, with the form still on the page, and does NOT open the game by itself', async () => {
    pending();
    renderAt(path);
    expect(waking()).toBeNull(); // not before the backend is actually slow
    await advance(2_000);

    expect(waking()).toHaveTextContent(/waking up/i);
    expect(screen.getByRole('button', { name: 'Play while you wait' })).toBeInTheDocument();
    expect(screen.getByLabelText(/email address/i)).toBeInTheDocument();
    for (const ms of [1_000, 10_000, 60_000]) {
      await advance(ms);
      expect(overlay()).toBeNull();
    }
  });

  it('"Play while you wait" opens the game; once the backend is ready it closes with the ready beat, and the form is usable', async () => {
    answers('no-answer', 'ok');
    renderAt(path);
    await advance(0); // the first probe came back empty: waking
    expect(overlay()).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    expect(overlay()).toBeInTheDocument();
    expect(screen.getByText(/Waking up the server/)).toBeInTheDocument();

    await advance(2_000); // the next probe is ok
    expect(screen.getByText(/Server is ready!/)).toBeInTheDocument();
    await finishClose();
    expect(overlay()).toBeNull();
    expect(waking()).toBeNull();
    expect(screen.getByLabelText(/email address/i)).toBeEnabled();
  });

  it('shows a failure notice, not the cold-start wording, when the backend never answers', async () => {
    answers('no-answer');
    renderAt(path);
    await advance(100_000);

    expect(overlay()).toBeNull();
    expect(screen.queryByText(/Server is ready!/)).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/couldn't reach the server/i);
    expect(screen.getByLabelText(/email address/i)).toBeEnabled(); // a notice never locks the form
  });

  it('a refresh (a new mount) starts the check again from scratch, and still opens no game', async () => {
    answers('ok');
    const first = renderAt(path);
    await advance(0);
    first.unmount();

    pending();
    renderAt(path);
    await advance(2_000);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(waking()).toBeInTheDocument();
    expect(overlay()).toBeNull();
  });

  it('touches no protected data: the page only ever asks for readiness, never an authenticated endpoint', async () => {
    const requests = vi.spyOn(apiClient, 'request');
    const get = vi.spyOn(apiClient, 'get');
    pending();
    renderAt(path);
    await advance(10_000);

    expect(waking()).toBeInTheDocument();
    expect(requests).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(useAuthStore.getState().token).toBeNull();
    expect(probe).toHaveBeenCalledWith(expect.any(AbortSignal)); // and the probe takes no credentials at all
  });
});

describe('normal behaviour when the backend is already available', () => {
  it('login shows no overlay and no notice, and signing in works exactly as before', async () => {
    answers('ok');
    renderAt('/login');
    await advance(0);
    expect(overlay()).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();

    vi.mocked(authService.login).mockResolvedValue({
      token: 'a.b.c',
      user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
    } as never);
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'correct horse' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await advance(0);

    expect(authService.login).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'correct horse' });
  });

  it('a failed login while the backend is healthy still shows the normal login error, not a warm-up message', async () => {
    answers('ok');
    renderAt('/login');
    await advance(0);

    vi.mocked(authService.login).mockRejectedValue({ response: { data: { message: 'Invalid email or password' } } });
    fireEvent.change(screen.getByLabelText(/email address/i), { target: { value: 'ada@example.com' } });
    fireEvent.change(screen.getByLabelText(/^password/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await advance(0);

    expect(screen.getByRole('alert')).toHaveTextContent('Invalid email or password');
    expect(overlay()).toBeNull();
  });
});


describe('password visibility controls', () => {
  it('keeps passwords masked by default and toggles visibility accessibly on login', async () => {
    answers('ok');
    renderAt('/login');
    await advance(0);

    const password = screen.getByLabelText('Password') as HTMLInputElement;
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(password.type).toBe('password');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(toggle);

    expect(password.type).toBe('text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(password.type).toBe('password');
  });

  it('provides independent visibility controls for both registration passwords', async () => {
    answers('ok');
    renderAt('/register');
    await advance(0);

    const password = screen.getByLabelText('Password') as HTMLInputElement;
    const confirm = screen.getByLabelText('Confirm password') as HTMLInputElement;
    const toggles = screen.getAllByRole('button', { name: 'Show password' });

    expect(password.type).toBe('password');
    expect(confirm.type).toBe('password');
    expect(toggles).toHaveLength(2);

    fireEvent.click(toggles[0]);
    expect(password.type).toBe('text');
    expect(confirm.type).toBe('password');

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
    expect(confirm.type).toBe('text');
  });

  it('keeps reset passwords masked by default and preserves mismatch validation', async () => {
    answers('ok');
    render(
      <MemoryRouter initialEntries={['/reset-password']}>
        <LaunchProvider pacing={FIXED_PACING}>
          <Routes>
            <Route path="/reset-password" element={<ResetPasswordPage />} />
            <Route path="/login" element={<p>login</p>} />
            <Route path="/forgot-password" element={<p>forgot</p>} />
          </Routes>
        </LaunchProvider>
      </MemoryRouter>,
    );
    await advance(0);

    const password = screen.getByLabelText('New password') as HTMLInputElement;
    const confirm = screen.getByLabelText('Confirm new password') as HTMLInputElement;
    expect(password.type).toBe('password');
    expect(confirm.type).toBe('password');

    fireEvent.change(password, { target: { value: 'secret123' } });
    fireEvent.change(confirm, { target: { value: 'different123' } });
    expect(screen.getByRole('alert')).toHaveTextContent(/don't match/i);
    expect(screen.getByRole('button', { name: 'Reset password' })).toBeDisabled();
  });
});
