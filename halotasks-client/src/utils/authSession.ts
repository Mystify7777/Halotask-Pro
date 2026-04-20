const KNOWN_USER_KEY = 'halotasks_known_user';

const decodeJwtPayload = (token: string): { exp?: number } | null => {
  try {
    const segments = token.split('.');
    if (segments.length < 2) {
      return null;
    }

    const payload = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const normalized = payload.padEnd(Math.ceil(payload.length / 4) * 4, '=');
    const json = atob(normalized);
    return JSON.parse(json) as { exp?: number };
  } catch {
    return null;
  }
};

export const isSessionTokenValid = (token: string | null): boolean => {
  if (!token) {
    return false;
  }

  const payload = decodeJwtPayload(token);
  if (!payload?.exp) {
    return false;
  }

  const nowInSeconds = Math.floor(Date.now() / 1000);
  return payload.exp > nowInSeconds;
};

export const markKnownUser = (): void => {
  localStorage.setItem(KNOWN_USER_KEY, 'true');
};

export const isKnownUser = (): boolean => {
  return localStorage.getItem(KNOWN_USER_KEY) === 'true';
};
