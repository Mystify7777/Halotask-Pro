import type { SessionClass } from './launchState';

/**
 * Which pages need the server's readiness at all (Issue #49, 49C). The probe is a real request, so it runs only where
 * something uses the answer:
 *   - any page, once there is a session to confirm (the authenticated app, and the sign-in pages a signed-in person may open);
 *   - the pre-sign-in forms that talk to the server: sign in, register, and the two password-reset pages (each shows the
 *     warm-up experience, Issue #12).
 * Everything else, for an anonymous visitor (the landing page, an unknown address), does not probe.
 */
export const PROBED_PUBLIC_PATHS: readonly string[] = ['/login', '/register', '/forgot-password', '/reset-password'];

export function wantsServerReadiness(pathname: string, session: SessionClass): boolean {
  if (session.kind !== 'none') return true;
  return PROBED_PUBLIC_PATHS.includes(pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname);
}
