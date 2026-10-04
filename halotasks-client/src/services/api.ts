import axios, { type AxiosRequestConfig } from 'axios';
import { useAuthStore } from '../store/authStore';
import { TOKEN_KEY } from '../store/authStore';

export const getApiErrorMessage = (error: unknown, fallback = 'Something went wrong'): string => {
  if (axios.isAxiosError(error)) {
    return error.response?.data?.message ?? fallback;
  }

  return fallback;
};

/**
 * The account + credential a caller captured earlier and wants a request sent with — or not sent at all.
 *
 * Ordinary requests send whatever token is current when they are built. That is wrong for work that
 * belongs to one account but runs later across awaits (the offline queue): the signed-in account can
 * change in between, and a check made before the call does not protect the call. Passing a session makes
 * the request interceptor verify the store against it and apply the bound token in ONE synchronous step —
 * nothing can change between "verified" and "sent" — or refuse to send.
 */
export type BoundSession = { userId: string; token: string };
export type SessionRequestConfig = AxiosRequestConfig & { session?: BoundSession };

/** The signed-in account and its token right now; null unless both exist. */
export const captureSession = (): BoundSession | null => {
  const { user, token } = useAuthStore.getState();
  return user?.id && token ? { userId: user.id, token } : null;
};

export const isSameSession = (a: BoundSession | null, b: BoundSession | null): boolean =>
  a !== null && b !== null && a.userId === b.userId && a.token === b.token;

/** Thrown (before anything is sent) when a request's bound session is no longer the signed-in one. */
export class SessionChangedError extends Error {
  readonly code = 'SESSION_CHANGED';

  constructor() {
    super('The signed-in session changed before this request was sent');
    this.name = 'SessionChangedError';
  }
}

export const isSessionChangedError = (error: unknown): error is SessionChangedError =>
  error instanceof SessionChangedError;

export const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:5000',
  timeout: 60_000,
  headers: {
    'Content-Type': 'application/json',
  },
});

apiClient.interceptors.request.use((config) => {
  const bound = (config as SessionRequestConfig).session;

  if (bound) {
    // Verify and apply in the same synchronous step: no await sits between the check and the header,
    // so the account cannot switch in between. The header comes from the BOUND token, never a re-read.
    if (!isSameSession(captureSession(), bound)) {
      return Promise.reject(new SessionChangedError());
    }

    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${bound.token}`;
    return config;
  }

  const token = useAuthStore.getState().token ?? localStorage.getItem(TOKEN_KEY);

  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().clearAuth();
      window.location.replace('/login');
    }

    return Promise.reject(error);
  },
);