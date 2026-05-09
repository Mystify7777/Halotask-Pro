import { create } from 'zustand';
import { clearCachedAuthUser, setCachedAuthUser } from '../offline/cache';
import { AuthResponse, AuthUser } from '../types/auth';
import { isSessionTokenValid, markKnownUser } from '../utils/authSession';

type AuthState = {
  token: string | null;
  user: AuthUser | null;
  setAuth: (payload: AuthResponse) => void;
  clearAuth: () => void;
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
    };
  } catch {
    return null;
  }
};

export const useAuthStore = create<AuthState>((set) => ({
  token: getInitialToken(),
  user: getInitialUser(),
  setAuth: (payload) => {
    localStorage.setItem(TOKEN_KEY, payload.token);
    localStorage.setItem(USER_KEY, JSON.stringify(payload.user));
    markKnownUser();
    void setCachedAuthUser(payload.user);

    set({
      token: payload.token,
      user: payload.user,
    });
  },
  clearAuth: () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    void clearCachedAuthUser();

    set({
      token: null,
      user: null,
    });
  },
}));