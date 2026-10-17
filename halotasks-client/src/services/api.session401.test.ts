import { AxiosError, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #34: a 401 must only end the session that issued the request.
//
// Every request here is held inside a controlled adapter (a deferred the test settles by hand), so "the response
// arrives later, after the account changed" is produced by ordering, never by sleeping. The real API client, its
// real request/response interceptors and the real auth store run; only the network (adapter), IndexedDB (cache)
// and the page navigation (authRedirect) are replaced.

vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

import { apiClient, authRedirect, captureSession } from './api';
import { TOKEN_KEY, useAuthStore } from '../store/authStore';

const USER_A = { id: 'user-a', name: 'Alice', email: 'a@example.com' };
const USER_B = { id: 'user-b', name: 'Bob', email: 'b@example.com' };
const USER_C = { id: 'user-c', name: 'Cleo', email: 'c@example.com' };

const signIn = (user: typeof USER_A, token: string) => useAuthStore.getState().setAuth({ token, user } as never);
const logout = () => useAuthStore.getState().clearAuth();

type Held = { entered: Promise<void>; settle: (status: number) => void; authorization: () => string | null };
const held = new Map<string, { enter: () => void; settle: (status: number) => void; config?: InternalAxiosRequestConfig }>();

const originalAdapter = apiClient.defaults.adapter;
const realClearAuth = useAuthStore.getState().clearAuth;
let clearAuthCalls = 0;
let redirects = 0;

/** Starts a request and holds it in the adapter until the test settles it. */
const start = (url: string) => {
  let enter!: () => void;
  let settle!: (status: number) => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const entry: { enter: () => void; settle: (status: number) => void; config?: InternalAxiosRequestConfig } = { enter, settle: () => {} };
  const settled = new Promise<number>((resolve) => {
    settle = resolve;
  });
  entry.settle = settle;
  held.set(url, entry);
  const outcome = apiClient.get(url).then(
    (response) => ({ ok: true as const, status: response.status }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  void settled;
  const handle: Held & { outcome: typeof outcome } = {
    entered,
    settle: (status) => entry.settle(status),
    authorization: () => {
      const header = entry.config?.headers.get('Authorization');
      return typeof header === 'string' ? header : null;
    },
    outcome,
  };
  return handle;
};

beforeEach(() => {
  held.clear();
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
      entry.enter();
    });
});

afterEach(() => {
  apiClient.defaults.adapter = originalAdapter;
  vi.restoreAllMocks();
});

const expectSignedInAs = (user: typeof USER_A, token: string) => {
  expect(useAuthStore.getState().user).toEqual(user);
  expect(useAuthStore.getState().token).toBe(token);
  expect(localStorage.getItem(TOKEN_KEY)).toBe(token);
};

describe('the 401 of the session that is still signed in', () => {
  it('signs out, clears storage and goes to the login page, and the caller still gets the error', async () => {
    signIn(USER_A, 'token-a');
    const request = start('/api/tasks');
    await request.entered;
    expect(request.authorization()).toBe('Bearer token-a');

    request.settle(401);
    const result = await request.outcome;

    expect(result.ok).toBe(false);
    expect((result as { error: AxiosError }).error.response?.status).toBe(401);
    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('a request sent while signed out that is refused (the login form’s own 401) keeps its old behaviour', async () => {
    const request = start('/api/auth/login');
    await request.entered;
    expect(request.authorization()).toBeNull();

    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
  });
});

describe('a stale 401 from a previous session', () => {
  it('A’s delayed 401 after A logs out and B signs in does not touch B', async () => {
    signIn(USER_A, 'token-a');
    const aRequest = start('/api/a');
    await aRequest.entered;

    logout();
    signIn(USER_B, 'token-b');
    clearAuthCalls = 0; // only count what the stale response does

    aRequest.settle(401);
    const result = await aRequest.outcome;

    expect(result.ok).toBe(false); // the caller still sees the failure
    expect((result as { error: AxiosError }).error.response?.status).toBe(401);
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_B, 'token-b');
    expect(captureSession()).toEqual({ userId: 'user-b', token: 'token-b' });
  });

  it('the same account signing in again (a new token) is not signed out by its old session’s 401', async () => {
    signIn(USER_A, 'token-a-1');
    const old = start('/api/old');
    await old.entered;

    logout();
    signIn(USER_A, 'token-a-2');
    clearAuthCalls = 0;

    old.settle(401);
    await old.outcome;

    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_A, 'token-a-2');
  });

  it('a request sent while signed out, answered after someone signed in, does not sign them out', async () => {
    const early = start('/api/early');
    await early.entered;

    signIn(USER_B, 'token-b');
    clearAuthCalls = 0;

    early.settle(401);
    await early.outcome;

    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_B, 'token-b');
  });

  it('A’s 401 after A logged out and nobody signed in only finds the signed-out state (no second redirect)', async () => {
    signIn(USER_A, 'token-a');
    const aRequest = start('/api/a');
    await aRequest.entered;
    logout();
    clearAuthCalls = 0;

    aRequest.settle(401);
    await aRequest.outcome;

    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expect(useAuthStore.getState().token).toBeNull();
  });
});

describe('concurrent requests across a session change', () => {
  it('several stale 401s, settled in any order, never invalidate B while B’s own requests are in flight', async () => {
    signIn(USER_A, 'token-a');
    const a1 = start('/api/a1');
    const a2 = start('/api/a2');
    const a3 = start('/api/a3');
    await Promise.all([a1.entered, a2.entered, a3.entered]);

    logout();
    signIn(USER_B, 'token-b');
    const b1 = start('/api/b1');
    const b2 = start('/api/b2');
    await Promise.all([b1.entered, b2.entered]);
    expect(b1.authorization()).toBe('Bearer token-b');
    clearAuthCalls = 0;

    a2.settle(401);
    b1.settle(200);
    a3.settle(401);
    a1.settle(401);
    const results = await Promise.all([a1.outcome, a2.outcome, a3.outcome, b1.outcome]);

    expect(results.map((r) => r.ok)).toEqual([false, false, false, true]);
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_B, 'token-b');

    b2.settle(200); // B’s still-pending request completes normally
    expect((await b2.outcome).ok).toBe(true);
    expectSignedInAs(USER_B, 'token-b');
  });

  it('then a genuine 401 for B does sign B out (the stale ones did not use up or mask the real one)', async () => {
    signIn(USER_A, 'token-a');
    const stale = start('/api/stale');
    await stale.entered;
    logout();
    signIn(USER_B, 'token-b');
    const current = start('/api/current');
    await current.entered;
    clearAuthCalls = 0;

    stale.settle(401);
    await stale.outcome;
    expect(clearAuthCalls).toBe(0);

    current.settle(401);
    await current.outcome;
    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('two genuine 401s of the same session sign out once; the second finds nothing left to clear', async () => {
    signIn(USER_A, 'token-a');
    const one = start('/api/one');
    const two = start('/api/two');
    await Promise.all([one.entered, two.entered]);

    one.settle(401);
    await one.outcome;
    two.settle(401);
    await two.outcome;

    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
  });
});

describe('rapid account switching', () => {
  it('A → B → C → A again: every older request’s 401, in any order, leaves the latest session signed in', async () => {
    signIn(USER_A, 'token-a-1');
    const r1 = start('/api/r1');
    await r1.entered;
    logout();
    signIn(USER_B, 'token-b-1');
    const r2 = start('/api/r2');
    await r2.entered;
    logout();
    signIn(USER_C, 'token-c-1');
    const r3 = start('/api/r3');
    await r3.entered;
    logout();
    signIn(USER_A, 'token-a-2');
    const latest = start('/api/latest');
    await latest.entered;
    clearAuthCalls = 0;

    for (const stale of [r2, r1, r3]) {
      stale.settle(401);
      await stale.outcome;
      expectSignedInAs(USER_A, 'token-a-2');
    }
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);

    latest.settle(401);
    await latest.outcome;
    expect(clearAuthCalls).toBe(1);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('switching accounts without an explicit logout (sign-in replaces the session) is stale the same way', async () => {
    signIn(USER_A, 'token-a');
    const a = start('/api/a');
    await a.entered;
    signIn(USER_B, 'token-b');
    clearAuthCalls = 0;

    a.settle(401);
    await a.outcome;

    expect(clearAuthCalls).toBe(0);
    expectSignedInAs(USER_B, 'token-b');
  });
});

describe('everything else is unchanged', () => {
  it('a successful request resolves and touches nothing', async () => {
    signIn(USER_A, 'token-a');
    clearAuthCalls = 0;
    const request = start('/api/ok');
    await request.entered;
    expect(request.authorization()).toBe('Bearer token-a');

    request.settle(200);

    expect(await request.outcome).toEqual({ ok: true, status: 200 });
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_A, 'token-a');
  });

  it.each([400, 403, 404, 409, 429, 500, 503])('an ordinary %i rejects to the caller and does not sign out', async (status) => {
    signIn(USER_A, 'token-a');
    clearAuthCalls = 0;
    const request = start(`/api/e${status}`);
    await request.entered;

    request.settle(status);
    const result = await request.outcome;

    expect(result.ok).toBe(false);
    expect((result as { error: AxiosError }).error.response?.status).toBe(status);
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_A, 'token-a');
  });

  it('an error with no response (offline, timeout) rejects untouched and does not sign out', async () => {
    signIn(USER_A, 'token-a');
    clearAuthCalls = 0;
    apiClient.defaults.adapter = (config) => Promise.reject(new AxiosError('Network Error', 'ERR_NETWORK', config));

    await expect(apiClient.get('/api/x')).rejects.toMatchObject({ code: 'ERR_NETWORK' });
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_A, 'token-a');
  });

  it('a request uses the signed-in token, falling back to storage exactly as before', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-from-storage');
    const request = start('/api/fallback');
    await request.entered;
    expect(request.authorization()).toBe('Bearer token-from-storage');
    request.settle(200);
    await request.outcome;
  });

  it('a 401 for a token that only exists in storage (store empty) still clears it', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-from-storage');
    const request = start('/api/fallback');
    await request.entered;

    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(1);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });
});

describe('session identity is the session instance, not the token string', () => {
  it('log out, then log back in with the IDENTICAL token: the old request’s 401 does not end the new session', async () => {
    signIn(USER_A, 'same-token');
    const old = start('/api/old');
    await old.entered;
    expect(old.authorization()).toBe('Bearer same-token');

    logout();
    signIn(USER_A, 'same-token');
    clearAuthCalls = 0;

    old.settle(401);
    const result = await old.outcome;

    expect(result.ok).toBe(false); // the caller still sees the 401
    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_A, 'same-token');
  });

  it('signing in again over an existing session with the identical token also replaces the session', async () => {
    signIn(USER_A, 'same-token');
    const old = start('/api/old');
    await old.entered;

    signIn(USER_A, 'same-token'); // no logout in between
    clearAuthCalls = 0;

    old.settle(401);
    await old.outcome;

    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_A, 'same-token');
  });

  it('…and a request issued by the new session with that same token still ends it when refused', async () => {
    signIn(USER_A, 'same-token');
    const old = start('/api/old');
    await old.entered;
    logout();
    signIn(USER_A, 'same-token');
    const current = start('/api/current');
    await current.entered;
    clearAuthCalls = 0;

    old.settle(401);
    await old.outcome;
    expect(clearAuthCalls).toBe(0);

    current.settle(401);
    await current.outcome;
    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('rapid switching that returns to the identical token (A → B → A with the same token) leaves the latest session alone', async () => {
    signIn(USER_A, 'same-token');
    const first = start('/api/first');
    await first.entered;
    logout();
    signIn(USER_B, 'token-b');
    const middle = start('/api/middle');
    await middle.entered;
    logout();
    signIn(USER_A, 'same-token');
    clearAuthCalls = 0;

    for (const stale of [middle, first]) {
      stale.settle(401);
      await stale.outcome;
    }

    expect(clearAuthCalls).toBe(0);
    expectSignedInAs(USER_A, 'same-token');
  });

  it('the generation is memory-only: nothing about it reaches storage, and it moves on every login and logout', () => {
    const start0 = useAuthStore.getState().sessionGeneration;
    signIn(USER_A, 'token-a');
    expect(useAuthStore.getState().sessionGeneration).toBe(start0 + 1);
    signIn(USER_A, 'token-a');
    expect(useAuthStore.getState().sessionGeneration).toBe(start0 + 2);
    logout();
    expect(useAuthStore.getState().sessionGeneration).toBe(start0 + 3);

    signIn(USER_B, 'token-b');
    const stored = Object.entries({ ...localStorage });
    expect(stored.map(([key]) => key.toLowerCase()).filter((key) => key.includes('generation'))).toEqual([]);
    expect(stored.some(([, value]) => value.includes('sessionGeneration'))).toBe(false);
  });
});

describe('the store and storage fallback: what counts as the active session', () => {
  it('login and logout always change store and storage together', () => {
    signIn(USER_A, 'token-a');
    expect(useAuthStore.getState().token).toBe('token-a');
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-a');

    logout();
    expect(useAuthStore.getState().token).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem('halotasks_user')).toBeNull();
  });

  it('store empty, token only in storage (another tab signed in): the request uses it, and its own 401 clears it', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-from-other-tab');
    const request = start('/api/x');
    await request.entered;
    expect(request.authorization()).toBe('Bearer token-from-other-tab');

    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(1);
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('store empty, token only in storage: signing in here before the 401 arrives makes that 401 stale', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-from-other-tab');
    const request = start('/api/x');
    await request.entered;

    signIn(USER_B, 'token-b');
    clearAuthCalls = 0;

    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expectSignedInAs(USER_B, 'token-b');
  });

  it('store empty: the stored token being replaced by another tab before the 401 arrives makes that 401 stale', async () => {
    localStorage.setItem(TOKEN_KEY, 'token-old');
    const request = start('/api/x');
    await request.entered;

    localStorage.setItem(TOKEN_KEY, 'token-new'); // another tab signed in again

    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(0);
    expect(redirects).toBe(0);
    expect(localStorage.getItem(TOKEN_KEY)).toBe('token-new');
  });

  it('a request sent with the store token is stale after logout even if storage still holds a leftover token', async () => {
    signIn(USER_A, 'token-a');
    const request = start('/api/a');
    await request.entered;
    logout();
    localStorage.setItem(TOKEN_KEY, 'token-a'); // a leftover that logout should have removed
    clearAuthCalls = 0;

    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(0); // the generation says the session that sent it has ended
    expect(redirects).toBe(0);
  });
});

describe('precedence when this tab holds a token and storage differs (no cross-tab sync)', () => {
  it('the store token wins: the request carries it, and another tab’s different stored token is not noticed', async () => {
    signIn(USER_A, 'token-a');
    localStorage.setItem(TOKEN_KEY, 'token-from-other-tab'); // another tab signed in; this tab is not told
    const request = start('/api/x');
    await request.entered;
    expect(request.authorization()).toBe('Bearer token-a');

    request.settle(401);
    await request.outcome;

    // This tab's own session still ends on its own 401 (and clears the shared storage entry, as clearAuth always did).
    expect(clearAuthCalls).toBe(1);
    expect(redirects).toBe(1);
    expect(useAuthStore.getState().token).toBeNull();
  });

  it('a change to the stored token while the store holds one does not make that session’s 401 stale', async () => {
    signIn(USER_A, 'token-a');
    const request = start('/api/x');
    await request.entered;

    localStorage.setItem(TOKEN_KEY, 'token-from-other-tab');
    request.settle(401);
    await request.outcome;

    expect(clearAuthCalls).toBe(1);
  });
});

describe('hydration from storage', () => {
  const jwt = (exp: number) => `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '')}.s`;
  const freshStore = async () => {
    vi.resetModules();
    return (await import('../store/authStore')).useAuthStore;
  };

  it('a valid stored session is hydrated as generation 0', async () => {
    const token = jwt(Math.floor(Date.now() / 1000) + 3600);
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem('halotasks_user', JSON.stringify(USER_A));

    const store = await freshStore();

    expect(store.getState().token).toBe(token);
    expect(store.getState().user).toEqual(USER_A);
    expect(store.getState().sessionGeneration).toBe(0);
  });

  it.each([
    ['an expired token', () => jwt(Math.floor(Date.now() / 1000) - 10)],
    ['a malformed token', () => 'not-a-jwt'],
  ])('%s is dropped from the store AND from storage', async (_name, make) => {
    localStorage.setItem(TOKEN_KEY, make());
    localStorage.setItem('halotasks_user', JSON.stringify(USER_A));

    const store = await freshStore();

    expect(store.getState().token).toBeNull();
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    expect(localStorage.getItem('halotasks_user')).toBeNull();
  });
});
