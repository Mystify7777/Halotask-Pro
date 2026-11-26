import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #46: a password change revokes the token this tab is using the moment the server commits it, while the client
// only swaps to the new token when the answer arrives. Any other request of the old session that reaches the server in
// between is refused 401 although the session is fine. These tests hold requests in a controlled adapter so that
// interleaving is produced by ordering, never by sleeping. The real API client, interceptors and auth store run.

vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));
const launch = vi.hoisted(() => ({ answers: [] as Array<{ sessionKey: string; verdict: string }> }));
vi.mock('../launch/sessionAnswers', () => ({ reportSessionAnswer: (a: { sessionKey: string; verdict: string }) => void launch.answers.push(a) }));

import { apiClient, authRedirect, captureSession, isSessionChangedError, runSessionSwap } from './api';
import { useAuthStore } from '../store/authStore';

const USER = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const OLD = 'token-old';
const NEW = 'token-new';

type Held = { config?: InternalAxiosRequestConfig; settle: (status: number) => void; entered: Promise<void> };
const held = new Map<string, Held>();
const hold = (url: string) => {
  let enter!: () => void;
  const entry: Held = { settle: () => {}, entered: new Promise<void>((r) => (enter = r)) };
  (entry as Held & { enter: () => void }).enter = enter;
  held.set(url, entry);
  return entry;
};

const originalAdapter = apiClient.defaults.adapter;
const realClearAuth = useAuthStore.getState().clearAuth;
let clearAuthCalls = 0;
let redirects = 0;

beforeEach(() => {
  held.clear();
  launch.answers.length = 0;
  clearAuthCalls = 0;
  redirects = 0;
  localStorage.clear();
  useAuthStore.setState({
    token: null,
    user: null,
    clearAuth: () => {
      clearAuthCalls += 1;
      realClearAuth();
    },
  });
  vi.spyOn(authRedirect, 'toLogin').mockImplementation(() => {
    redirects += 1;
  });
  apiClient.defaults.adapter = (config: InternalAxiosRequestConfig): Promise<AxiosResponse> =>
    new Promise((resolve, reject) => {
      const entry = held.get(String(config.url));
      if (!entry) throw new Error(`unexpected request ${String(config.url)}`);
      entry.config = config;
      entry.settle = (status: number) => {
        const response = { data: {}, status, statusText: String(status), headers: {}, config } as AxiosResponse;
        if (status >= 200 && status < 300) resolve(response);
        else reject(new AxiosError(`HTTP ${status}`, 'ERR_BAD_REQUEST', config, undefined, response));
      };
      (entry as Held & { enter: () => void }).enter();
    });
  useAuthStore.getState().setAuth({ token: OLD, user: USER } as never);
});
afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

const swap = (url: string) =>
  runSessionSwap(async () => {
    await apiClient.put(url, {}, { sessionSwap: true });
    useAuthStore.getState().setAuth({ token: NEW, user: USER } as never);
  });

describe('a request of the old session refused while the password change is in flight', () => {
  it('does not sign the user out, redirect, or tell the launch provider the session is invalid', async () => {
    const change = hold('/api/user/password');
    const stray = hold('/api/tasks/sync');
    const swapped = swap('/api/user/password');
    const other = apiClient.get('/api/tasks/sync').catch((e: unknown) => e);
    await Promise.all([change.entered, stray.entered]);

    stray.settle(401); // the server already committed the change; the answer has not reached the client yet
    const error = (await other) as AxiosError;
    expect(error.response?.status).toBe(401); // the caller still gets its error
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expect(launch.answers).toEqual([]);
    expect(useAuthStore.getState().token).toBe(OLD);

    change.settle(200);
    await swapped;
    expect(useAuthStore.getState().token).toBe(NEW);
    expect(clearAuthCalls).toBe(0);
  });

  it('a 401 of that old session arriving AFTER the swap is stale by generation and leaves the new session alone', async () => {
    const change = hold('/api/user/password');
    const stray = hold('/api/tasks/sync');
    const swapped = swap('/api/user/password');
    const other = apiClient.get('/api/tasks/sync').catch((e: unknown) => e);
    await Promise.all([change.entered, stray.entered]);
    change.settle(200);
    await swapped;
    stray.settle(401);
    await other;
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expect(useAuthStore.getState().token).toBe(NEW);
  });

  it('the guard ends with the operation: a later 401 of the current session signs out as before', async () => {
    const change = hold('/api/user/password');
    const swapped = swap('/api/user/password');
    await change.entered;
    change.settle(200);
    await swapped;

    const later = hold('/api/tasks/sync');
    const request = apiClient.get('/api/tasks/sync').catch((e: unknown) => e);
    await later.entered;
    later.settle(401);
    await request;
    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
  });

  it('the guard also ends when the change FAILS, so a 401 afterwards is honoured', async () => {
    const change = hold('/api/user/password');
    const swapped = swap('/api/user/password').catch((e: unknown) => e);
    await change.entered;
    change.settle(403); // wrong current password
    await swapped;
    expect(clearAuthCalls).toBe(0); // a 403 never signs out

    const later = hold('/api/tasks/sync');
    const request = apiClient.get('/api/tasks/sync').catch((e: unknown) => e);
    await later.entered;
    later.settle(401);
    await request;
    expect(clearAuthCalls).toBe(1);
  });
});

describe('the password-change request itself', () => {
  it('a genuine 401 on it (the session is already dead) still signs out', async () => {
    const change = hold('/api/user/password');
    const swapped = swap('/api/user/password').catch((e: unknown) => e);
    await change.entered;
    change.settle(401);
    await swapped;
    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
  });

  it('a 403 (wrong current password) does not sign out and is reported to nobody as an invalid session', async () => {
    const change = hold('/api/user/password');
    const swapped = swap('/api/user/password').catch((e: unknown) => e);
    await change.entered;
    change.settle(403);
    await swapped;
    expect(clearAuthCalls).toBe(0);
    expect(launch.answers.filter((a) => a.verdict === 'invalid')).toEqual([]);
    expect(useAuthStore.getState().token).toBe(OLD);
  });
});

describe('work bound to the old session (the offline queue)', () => {
  it('a request bound to the old session is refused before sending after the swap; one bound to the new session goes out with the new token', async () => {
    const bound = captureSession()!;
    useAuthStore.getState().setAuth({ token: NEW, user: USER } as never);

    await expect(apiClient.get('/api/never-sent', { session: bound } as never)).rejects.toSatisfy(isSessionChangedError);

    const fresh = hold('/api/tasks/sync');
    const request = apiClient.get('/api/tasks/sync', { session: captureSession()! } as never);
    await fresh.entered;
    expect(fresh.config?.headers.get('Authorization')).toBe(`Bearer ${NEW}`);
    fresh.settle(200);
    await request;
  });
});
