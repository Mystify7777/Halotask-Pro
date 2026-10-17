import axios, { type AxiosRequestConfig } from 'axios';
import { resolveApiBaseUrl } from '../config/apiBaseUrl';
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

declare module 'axios' {
  interface AxiosRequestConfig {
    /** In-memory marker set by the request interceptor: the auth store's sessionGeneration when the request was issued. */
    sessionGeneration?: number;
  }
}

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

/** The bearer token an ordinary (unbound) request would be sent with right now, or null when signed out. */
const credentialInUse = (): string | null => useAuthStore.getState().token ?? localStorage.getItem(TOKEN_KEY);

/** Where a refused session sends the user. A seam so tests can observe it (jsdom cannot navigate). */
export const authRedirect = {
  toLogin: (): void => window.location.replace('/login'),
};

/** The bearer token a request actually carried, read back from the Authorization header it was sent with. */
const bearerSentWith = (config: { headers?: unknown } | undefined): string | null => {
  const headers = config?.headers as { get?: (name: string) => unknown; Authorization?: unknown } | undefined;
  const value = typeof headers?.get === 'function' ? headers.get('Authorization') : headers?.Authorization;
  return typeof value === 'string' && value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
};

/**
 * Whether a failed request was issued by the session that is signed in NOW.
 *
 * A response can arrive long after the request was sent, across a logout and another login. Two independent
 * facts must both still hold for the request to count as the current session's:
 *   1. the session GENERATION stamped on the request when it was issued is still the store's current one. This is
 *      the session-instance identity: it changes on every login and logout, so it also tells apart a re-login that
 *      happens to receive the very same token string;
 *   2. the credential the request was sent with is still the credential in use (the same store-then-storage
 *      lookup the request interceptor uses: the store token if there is one, otherwise the stored token). With an
 *      empty store this also catches the stored token being replaced by another tab; with a token in the store
 *      another tab's change is not seen at all (there is no cross-tab sync).
 * A request sent while signed out belongs to "signed out": it still counts if nobody has signed in since (the
 * login form's own 401 keeps its behaviour), and it is stale once someone has. A request with no generation stamp
 * (not produced by this client's interceptor) is judged on the credential alone.
 */
const issuedByActiveSession = (config: { headers?: unknown; sessionGeneration?: number } | undefined): boolean => {
  const generation = config?.sessionGeneration;
  if (generation !== undefined && generation !== useAuthStore.getState().sessionGeneration) return false;
  return bearerSentWith(config) === credentialInUse();
};

export const apiClient = axios.create({
  // Vite inlines this value at build time, so the primary guard lives in vite.config.ts; resolving it here too
  // means a production bundle can never fall back to localhost even if that guard were bypassed.
  baseURL: resolveApiBaseUrl({
    value: import.meta.env.VITE_API_BASE_URL,
    isProduction: import.meta.env.PROD,
  }),
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
    config.sessionGeneration = useAuthStore.getState().sessionGeneration;
    return config;
  }

  const token = credentialInUse();

  if (token) {
    config.headers = config.headers ?? {};
    config.headers.Authorization = `Bearer ${token}`;
  }

  config.sessionGeneration = useAuthStore.getState().sessionGeneration;
  return config;
});

apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    // A 401 only ends the session that issued the request. A late 401 for a previous account (logged out,
    // then another account signed in while the request was in flight) says nothing about the current one.
    if (error?.response?.status === 401 && issuedByActiveSession(error.config)) {
      useAuthStore.getState().clearAuth();
      authRedirect.toLogin();
    }

    return Promise.reject(error);
  },
);