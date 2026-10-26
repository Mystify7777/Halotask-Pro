import { create } from 'zustand';
import { clearCachedAuthUser, setCachedAuthUser } from '../offline/cache';
import { AuthResponse, AuthUser } from '../types/auth';
import { isSessionTokenValid, markKnownUser } from '../utils/authSession';
import { isUsableTimeZone, setPreferredTimeZone } from '../utils/timeZone';

type AuthState = {
  token: string | null;
  user: AuthUser | null;
  /**
   * Which session instance is current: 0 for whatever was hydrated at startup, +1 every time the session is
   * replaced (setAuth, even with an identical token) or ended (clearAuth). In memory only, never persisted,
   * and never a credential. The API client stamps each request with it so a late response can tell whether the
   * session that sent the request is still the one in place (Issue #34).
   */
  sessionGeneration: number;
  setAuth: (payload: AuthResponse) => void;
  clearAuth: () => void;
  /**
   * Records the time zone the SERVER has confirmed (Issue #41): null when the saved choice was cleared. It edits the
   * signed-in user in place (store, localStorage and the offline cache) and is not a new session, so
   * `sessionGeneration` does not change. Call it only with a value the server returned, never with a guess.
   */
  setUserTimeZone: (timeZone: string | null) => void;
};

export const TOKEN_KEY = 'halotasks_token';
const USER_KEY = 'halotasks_user';

const getInitialToken = () => {
  const token = localStorage.getItem(TOKEN_KEY);

  if (!token || !isSessionTokenValid(token)) {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    return null;
  }

  return token;
};

const getInitialUser = (): AuthUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AuthUser>;

    if (!parsed?.id || !parsed?.email || !parsed?.name) {
      return null;
    }

    return {
      id: parsed.id,
      email: parsed.email,
      name: parsed.name,
      // A session stored before the preference existed has no field: that stays "no saved choice", it is not
      // filled in with the device's zone.
      ...(isUsableTimeZone(parsed.timeZone) ? { timeZone: parsed.timeZone } : {}),
    };
  } catch {
    return null;
  }
};

// Invariant the API client relies on: within this tab the token in localStorage and the token in this store
// change together, and only here (setAuth writes both, clearAuth removes both, and hydration drops an expired or
// malformed stored token from both).
//
// Precedence, as the API client applies it: a non-null token in THIS store always wins; localStorage is consulted
// only while the store token is null. There is deliberately NO cross-tab synchronization (no `storage` listener):
// another tab signing in or out after this tab loaded is not noticed by a tab that already holds an in-memory
// token, which keeps using it. A tab whose store is empty does pick up whatever token is in storage. Keeping tabs
// in step would need its own change and is outside Issue #34.
export const useAuthStore = create<AuthState>((set, get) => ({
  token: getInitialToken(),
  user: getInitialUser(),
  sessionGeneration: 0,
  setAuth: (payload) => {
    setPreferredTimeZone(payload.user.timeZone);
    localStorage.setItem(TOKEN_KEY, payload.token);
    localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
    markKnownUser();
    void setCachedAuthUser(payload.user);

    set((state) => ({
      token: payload.token,
      user: payload.user,
      sessionGeneration: state.sessionGeneration + 1,
    }));
  },
  setUserTimeZone: (timeZone) => {
    const current = get().user;
    if (!current) return;

    const { timeZone: _previous, ...rest } = current;
    const user: AuthUser = timeZone === null ? rest : { ...rest, timeZone };
    localStorage.setItem(USER_KEY, JSON.stringify(user));
    void setCachedAuthUser(user);
    setPreferredTimeZone(timeZone);

    set({ user });
  },
  clearAuth: () => {
    setPreferredTimeZone(null);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    void clearCachedAuthUser();

    set((state) => ({
      token: null,
      user: null,
      sessionGeneration: state.sessionGeneration + 1,
    }));
  },
}));

// The effective time zone must be right before the first render, so mirror whatever was hydrated above. A hydrated
// user whose token was dropped is not signed in, and then has no preference either.
{
  const { token, user } = useAuthStore.getState();
  setPreferredTimeZone(token ? user?.timeZone : null);
}
