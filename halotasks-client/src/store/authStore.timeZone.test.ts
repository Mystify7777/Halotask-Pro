import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inTimeZone } from '../test/taskFactory';

// Issue #41 — the saved time zone in the auth store: restored on startup (refresh), set by sign-in, never replaced by
// the device's zone, and never carried from one account to the next. IndexedDB is replaced; the store and the zone
// module are the real ones, re-imported per test so "a fresh page load" is a real module load.

const cache = vi.hoisted(() => ({ set: [] as unknown[], cleared: 0 }));
vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async (user: unknown) => {
    cache.set.push(user);
  }),
  clearCachedAuthUser: vi.fn(async () => {
    cache.cleared += 1;
  }),
}));

const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '');
const tokenExpiring = (secondsFromNow: number) => `${b64({ alg: 'HS256' })}.${b64({ exp: Math.floor(Date.now() / 1000) + secondsFromNow })}.sig`;

const USER_KEY = 'halotasks_user';
const TOKEN_KEY = 'halotasks_token';
const ALICE = { id: 'a', name: 'Alice', email: 'a@x.test' };

/** A fresh page load: new store and zone modules reading whatever is in localStorage. */
const loadFresh = async () => {
  vi.resetModules();
  const store = await import('./authStore');
  const zone = await import('../utils/timeZone');
  return { useAuthStore: store.useAuthStore, ...zone };
};

beforeEach(() => {
  localStorage.clear();
  cache.set.length = 0;
  cache.cleared = 0;
});

afterEach(() => {
  localStorage.clear();
});

describe('hydration (a page refresh)', () => {
  it('restores the saved time zone from the stored user, before anything renders', async () => {
    localStorage.setItem(TOKEN_KEY, tokenExpiring(3600));
    localStorage.setItem(USER_KEY, JSON.stringify({ ...ALICE, timeZone: 'Asia/Kolkata' }));

    const { useAuthStore, getEffectiveTimeZone, getPreferredTimeZone } = await loadFresh();

    expect(useAuthStore.getState().user?.timeZone).toBe('Asia/Kolkata');
    expect(getPreferredTimeZone()).toBe('Asia/Kolkata');
    expect(getEffectiveTimeZone()).toBe('Asia/Kolkata');
  });

  it('a stored user from before the preference existed has none, and the device zone is only a fallback', async () => {
    localStorage.setItem(TOKEN_KEY, tokenExpiring(3600));
    localStorage.setItem(USER_KEY, JSON.stringify(ALICE)); // exactly what older versions stored

    const { useAuthStore, getEffectiveTimeZone, getPreferredTimeZone } = await loadFresh();
    // inTimeZone is synchronous (it restores the machine zone when its callback returns), so only sync work goes in it.
    inTimeZone('America/Los_Angeles', () => {
      expect(useAuthStore.getState().user).toEqual(ALICE);
      expect(useAuthStore.getState().user).not.toHaveProperty('timeZone');
      expect(getPreferredTimeZone()).toBeNull();
      expect(getEffectiveTimeZone()).toBe('America/Los_Angeles');
    });
    expect(JSON.parse(localStorage.getItem(USER_KEY)!)).toEqual(ALICE); // nothing was written back
  });

  it.each(['+05:30', 'Nowhere/Land', '', 5, null])('drops an unusable stored value (%j) instead of trusting it', async (bad) => {
    localStorage.setItem(TOKEN_KEY, tokenExpiring(3600));
    localStorage.setItem(USER_KEY, JSON.stringify({ ...ALICE, timeZone: bad }));

    const { useAuthStore, getPreferredTimeZone } = await loadFresh();

    expect(useAuthStore.getState().user).toEqual(ALICE);
    expect(getPreferredTimeZone()).toBeNull();
  });

  it('an expired session restores nothing, so a stale preference cannot leak into the next sign-in', async () => {
    localStorage.setItem(TOKEN_KEY, tokenExpiring(-60));
    localStorage.setItem(USER_KEY, JSON.stringify({ ...ALICE, timeZone: 'Asia/Kolkata' }));

    const { useAuthStore, getPreferredTimeZone } = await loadFresh();

    expect(useAuthStore.getState().user).toBeNull();
    expect(getPreferredTimeZone()).toBeNull();
  });
});

describe('sign-in', () => {
  it('uses the zone the server returned and stores it with the user', async () => {
    const { useAuthStore, getEffectiveTimeZone } = await loadFresh();

    useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: { ...ALICE, timeZone: 'Pacific/Kiritimati' } });

    expect(getEffectiveTimeZone()).toBe('Pacific/Kiritimati');
    expect(JSON.parse(localStorage.getItem(USER_KEY)!).timeZone).toBe('Pacific/Kiritimati');
  });

  it('an old-shaped response (no field) or timeZone: null means no choice: the device zone is not saved', async () => {
    const { useAuthStore, getPreferredTimeZone, getEffectiveTimeZone } = await loadFresh();
    inTimeZone('America/Los_Angeles', () => {
      useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: ALICE });
      expect(getPreferredTimeZone()).toBeNull();
      expect(JSON.parse(localStorage.getItem(USER_KEY)!)).toEqual(ALICE);

      useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: { ...ALICE, timeZone: null } });
      expect(getPreferredTimeZone()).toBeNull();
      expect(getEffectiveTimeZone()).toBe('America/Los_Angeles');
    });
  });

  it('a second account never inherits the first account\'s zone', async () => {
    const { useAuthStore, getPreferredTimeZone } = await loadFresh();

    useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: { ...ALICE, timeZone: 'Asia/Kolkata' } });
    useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: { id: 'b', name: 'Bob', email: 'b@x.test' } });

    expect(getPreferredTimeZone()).toBeNull();
  });

  it('signing out clears the preference', async () => {
    const { useAuthStore, getPreferredTimeZone } = await loadFresh();
    useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: { ...ALICE, timeZone: 'Asia/Kolkata' } });

    useAuthStore.getState().clearAuth();

    expect(getPreferredTimeZone()).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });
});

describe('setUserTimeZone (a value the server confirmed)', () => {
  it('updates the user, localStorage, the offline cache and the effective zone, without ending the session', async () => {
    const { useAuthStore, getEffectiveTimeZone } = await loadFresh();
    const token = tokenExpiring(3600);
    useAuthStore.getState().setAuth({ token, user: ALICE });
    const generation = useAuthStore.getState().sessionGeneration;
    cache.set.length = 0;

    useAuthStore.getState().setUserTimeZone('Europe/London');

    const state = useAuthStore.getState();
    expect(state.user).toEqual({ ...ALICE, timeZone: 'Europe/London' });
    expect(state.token).toBe(token);
    expect(state.sessionGeneration).toBe(generation); // not a new session: nothing in flight is invalidated
    expect(getEffectiveTimeZone()).toBe('Europe/London');
    expect(JSON.parse(localStorage.getItem(USER_KEY)!)).toEqual({ ...ALICE, timeZone: 'Europe/London' });
    expect(cache.set).toEqual([{ ...ALICE, timeZone: 'Europe/London' }]);
  });

  it('survives a refresh: the next page load restores it', async () => {
    const first = await loadFresh();
    first.useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: ALICE });
    first.useAuthStore.getState().setUserTimeZone('Asia/Kolkata');

    const second = await loadFresh();

    expect(second.useAuthStore.getState().user?.timeZone).toBe('Asia/Kolkata');
    expect(second.getEffectiveTimeZone()).toBe('Asia/Kolkata');
  });

  it('null removes the saved choice (the key is gone, not stored as a fallback)', async () => {
    const { useAuthStore, getPreferredTimeZone } = await loadFresh();
    useAuthStore.getState().setAuth({ token: tokenExpiring(3600), user: { ...ALICE, timeZone: 'Asia/Kolkata' } });

    useAuthStore.getState().setUserTimeZone(null);

    expect(getPreferredTimeZone()).toBeNull();
    expect(useAuthStore.getState().user).toEqual(ALICE);
    expect(JSON.parse(localStorage.getItem(USER_KEY)!)).toEqual(ALICE);
  });

  it('does nothing when nobody is signed in', async () => {
    const { useAuthStore, getPreferredTimeZone } = await loadFresh();

    useAuthStore.getState().setUserTimeZone('Asia/Kolkata');

    expect(useAuthStore.getState().user).toBeNull();
    expect(getPreferredTimeZone()).toBeNull();
    expect(localStorage.getItem(USER_KEY)).toBeNull();
  });
});
