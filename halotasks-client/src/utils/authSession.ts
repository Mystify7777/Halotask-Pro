const KNOWN_USER_KEY = 'halotasks_known_user';

const decodeJwtPayload = (token: string): { exp?: unknown; userId?: unknown } | null => {
  try {
    const segments = token.split('.');
    if (segments.length < 2) {
      return null;
    }

    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const normalized = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = atob(normalized);
    return JSON.parse(json) as { exp?: unknown; userId?: unknown };
  } catch {
    return null;
  }
};

export const isSessionTokenValid = (token: string | null): boolean => {
  if (!token) {
    return false;
  }

  const exp = decodeJwtPayload(token)?.exp;
  // `exp` must be a real, finite number. A bare `exp > now` lets JavaScript coerce a string ("9999999999") or a one-element
  // array into a number, so a malformed claim could read as "unexpired". Real tokens always carry a numeric `exp`.
  if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  return exp > nowInSeconds;
};

/**
 * The account a token CLAIMS to belong to (its `userId`), read without verifying anything: the signature and the
 * server-side revocation counter can only be checked by the server. Null when the token is malformed or carries no id.
 * Use it to compare against the locally stored user, never as proof of who is signed in.
 */
export const getTokenUserId = (token: string | null): string | null => {
  if (!token) {
    return null;
  }

  const userId = decodeJwtPayload(token)?.userId;
  return typeof userId === 'string' && userId.length > 0 ? userId : null;
};

export const markKnownUser = (): void => {
  localStorage.setItem(KNOWN_USER_KEY, 'true');
};

export const isKnownUser = (): boolean => {
  return localStorage.getItem(KNOWN_USER_KEY) === 'true';
};

const ONBOARDING_KEY = 'halotasks_onboarding_done';

export const markOnboardingDone = (): void => {
  localStorage.setItem(ONBOARDING_KEY, 'true');
};

export const hasCompletedOnboarding = (): boolean => {
  return localStorage.getItem(ONBOARDING_KEY) === 'true';
};
