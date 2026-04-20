import { create } from 'zustand';
import { clearCachedAuthUser, setCachedAuthUser } from '../offline/cache';
import { AuthResponse, AuthUser } from '../types/auth';
import { markKnownUser } from '../utils/authSession';

type AuthState = {
  token: string | null;
  user: AuthUser | null;
  setAuth: (payload: AuthResponse) => void;
  clearAuth: () => void;
};

const TOKEN_KEY = 'halotasks_token';
const USER_KEY = 'halotasks_user';

const getInitialToken = () => localStorage.getItem(TOKEN_KEY);

const getInitialUser = (): AuthUser | null => {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as AuthUser;
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