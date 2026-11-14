import type { BackendFailureReason, BackendReadinessPhase } from '../hooks/useBackendReadiness';
import { getTokenUserId, isSessionTokenValid } from '../utils/authSession';

/**
 * The launch decision (Issue #49): what the app may show right now, given what the client can PROVE locally about the
 * session and what the server has (or has not) answered. Two pure functions, no React, no I/O, no timers: the UI expresses
 * this decision, it does not make it, and the same inputs always give the same answer (a refresh or a direct visit to any
 * route reaches the same state).
 *
 * SECURITY BOUNDARY. `trusted` is deliberately weaker than server authentication. It does not bypass server authorization:
 * every protected server operation still needs the server to validate the session (signature, revocation, token version),
 * and a 401 ends the session (`verdict: 'invalid'`). What `trusted` allows, offline, is access to data that is ALREADY on
 * this device (the local IndexedDB state and the offline queue) for a session whose token is unexpired and whose stored
 * account matches it. The client cannot verify a JWT signature or a server-side revocation offline, and this module never
 * pretends it can: nothing here makes a session `normal-online` without the server's own answer.
 *
 * Mapping to the states in the issue:
 *   INITIALIZING / RESTORING_LOCAL_SESSION  The auth store hydrates synchronously from localStorage before the first render,
 *                                           so by the time a decision is asked for, the session has been classified.
 *                                           (`classifySession` is the RESTORING_LOCAL_SESSION step.)
 *   CHECKING_SERVER                         `checking-server`
 *   SERVER_READY -> revalidate -> online    `revalidating`, then `normal-online`
 *   SERVER_UNAVAILABLE + trusted session    `offline-capable`
 *   SERVER_UNAVAILABLE + unverified session `waiting-room`
 *   invalid or absent credentials           `auth-flow`
 */

// ─── Session classification: what can be known WITHOUT the server ─────────────────────────────────────────────────

/**
 * Why credentials that are present cannot be trusted without the server.
 *  - 'expired-or-malformed': the token does not decode, has no `exp`, or `exp` has passed.
 *  - 'no-stored-user':       a token but no stored account to go with it (partial or damaged storage).
 *  - 'identity-mismatch':    the stored account is not the account the token names (a stale or swapped half).
 */
export type UnverifiedReason = 'expired-or-malformed' | 'no-stored-user' | 'identity-mismatch';

/**
 * - 'none':       no credentials at all (signed out, never signed in, or the store dropped an expired token at startup).
 * - 'trusted':    everything the client can check offline holds: a decodable, unexpired token AND a stored account whose id
 *                 is the token's `userId`. This is the exact meaning of "previously authenticated". It is NOT proof: the
 *                 signature and revocation (password reset bumps the server's token version) are only checked by the server.
 * - 'unverified': credentials exist but fail one of those checks.
 */
export type SessionClass = { kind: 'none' } | { kind: 'trusted' } | { kind: 'unverified'; reason: UnverifiedReason };

export function classifySession(input: { token: string | null; user: { id: string } | null }): SessionClass {
  const { token, user } = input;
  if (!token) return { kind: 'none' };
  if (!isSessionTokenValid(token)) return { kind: 'unverified', reason: 'expired-or-malformed' };
  if (!user?.id) return { kind: 'unverified', reason: 'no-stored-user' };
  if (getTokenUserId(token) !== user.id) return { kind: 'unverified', reason: 'identity-mismatch' };
  return { kind: 'trusted' };
}

// ─── Server availability, from the existing readiness hook ───────────────────────────────────────────────────────

/** Why the server cannot be used right now. Kept apart so the UI never mixes "no network" with "server down". */
export type UnavailableCause = 'browser-offline' | 'waking' | 'timeout' | 'unhealthy';

export type ServerStatus = { kind: 'checking' } | { kind: 'ready' } | { kind: 'unavailable'; cause: UnavailableCause };

/**
 * `useBackendReadiness` phases mapped to what the launch cares about. 'idle' only ever means the browser is offline (the
 * hook does not probe then). 'waking' and 'error' are both "not usable now"; they differ in cause, and the cause is kept.
 */
export function serverStatusFrom(phase: BackendReadinessPhase, reason: BackendFailureReason | null): ServerStatus {
  switch (phase) {
    case 'ready':
      return { kind: 'ready' };
    case 'checking':
    case 'dormant':
      // 'dormant' means nothing asked for the server (an anonymous page): the answer cannot matter then, and the first render
      // after a session appears reads as "checking", which is the quiet, correct start.
      return { kind: 'checking' };
    case 'idle':
      return { kind: 'unavailable', cause: 'browser-offline' };
    case 'waking':
      return { kind: 'unavailable', cause: 'waking' };
    case 'error':
      return { kind: 'unavailable', cause: causeFromFailure(reason) };
  }
}

/**
 * Every known failure reason is mapped explicitly. A reason added to `BackendFailureReason` later fails to compile here
 * (the `never` check) instead of being silently reported as a timeout. `null` cannot happen in the 'error' phase; it is
 * treated as a timeout, the generic "could not reach it".
 */
function causeFromFailure(reason: BackendFailureReason | null): UnavailableCause {
  switch (reason) {
    case 'unhealthy':
      return 'unhealthy';
    case 'timeout':
    case null:
      return 'timeout';
    default: {
      const unhandled: never = reason;
      return unhandled;
    }
  }
}

// ─── The decision ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What the server has said about THIS session. Set only from a real authenticated answer: 'valid' after one succeeds,
 * 'invalid' after a 401 for the current session. Never guessed, never inferred from a health probe (a health probe has no
 * session in it).
 */
export type SessionVerdict = 'unknown' | 'valid' | 'invalid';

/**
 * A verdict belongs to ONE session, never to the app. Store it as a `ScopedVerdict` keyed by the session it was given for,
 * and read it through `verdictFor` with the CURRENT session's key. That makes three bugs impossible by construction:
 *   - a verdict for user A is never inherited by user B who signs in afterwards (the keys differ, so it reads 'unknown');
 *   - nothing survives a sign-out (no current key, so it reads 'unknown');
 *   - a slow revalidation answer for A that arrives after B signed in cannot change B's state (`recordVerdict` drops it).
 * The key is the token itself: a new sign-in is a new credential and gets a new key. Keep the key in memory only.
 */
export type ScopedVerdict = { sessionKey: string; verdict: 'valid' | 'invalid' };

export const sessionKeyOf = (token: string | null): string | null => (token ? token : null);

export function verdictFor(scoped: ScopedVerdict | null, currentKey: string | null): SessionVerdict {
  if (!scoped || currentKey === null || scoped.sessionKey !== currentKey) return 'unknown';
  return scoped.verdict;
}

/**
 * Applies a server answer for `response.sessionKey`. Returns the new stored verdict: unchanged when the answer is for a
 * session that is no longer current, and 'invalid' stays 'invalid' for that session (a rejected token cannot become valid
 * again, so a late success for it is ignored).
 */
export function recordVerdict(current: ScopedVerdict | null, response: ScopedVerdict, currentKey: string | null): ScopedVerdict | null {
  if (currentKey === null || response.sessionKey !== currentKey) return current;
  if (current && current.sessionKey === currentKey && current.verdict === 'invalid') return current;
  return response;
}

/**
 * `checking-server` is NOT one UI. What it shows depends on the session, which is why `access` exists:
 *   trusted session    -> access 'app':  the app stays mounted from local data; at most a quiet readiness indication.
 *   untrusted session  -> access 'hold': nothing protected is rendered, and nothing alarming either.
 * Branch on `access`, never on `state === 'checking-server'` alone (a generic "checking means spinner" would either block a
 * trusted user behind the server or flash an untrusted one a half-mounted app).
 */
export type LaunchState =
  | 'checking-server' // the first readiness probe is out
  | 'revalidating' // the server answered; the session has not been confirmed by it yet
  | 'normal-online' // server ready AND the server confirmed the session
  | 'offline-capable' // server unavailable, session trusted locally: the local-first app, with an honest status
  | 'waiting-room' // server unavailable, credentials present but untrustworthy: nothing protected is shown
  | 'auth-flow'; // no usable credentials, or the server rejected the session: sign in

/**
 * What may be rendered.
 *  - 'app':          the authenticated application (local data, the offline queue).
 *  - 'hold':         nothing protected and nothing alarming yet (a decision is still pending).
 *  - 'waiting-room': the explanation + wait/retry experience, with only data-free extras (the Task Tapper game).
 *  - 'login':        the sign-in flow.
 */
export type LaunchAccess = 'app' | 'hold' | 'waiting-room' | 'login';

export type LaunchDecision = {
  state: LaunchState;
  access: LaunchAccess;
  /** Why the server is unavailable, when it is. Present exactly for `offline-capable` and `waiting-room`. */
  unavailable: UnavailableCause | null;
  /** Why credentials are untrusted, when they are. Present exactly when the session is 'unverified'. */
  unverified: UnverifiedReason | null;
};

export type LaunchInputs = { session: SessionClass; server: ServerStatus; verdict: SessionVerdict };

export function deriveLaunchState({ session, server, verdict }: LaunchInputs): LaunchDecision {
  const unavailable = server.kind === 'unavailable' ? server.cause : null;
  const unverified = session.kind === 'unverified' ? session.reason : null;
  const make = (state: LaunchState, access: LaunchAccess, withUnavailable = false): LaunchDecision => ({
    state,
    access,
    unavailable: withUnavailable ? unavailable : null,
    unverified,
  });

  // The server said no: that is final for this session whatever else is true (and whatever the health probe says).
  if (verdict === 'invalid') return make('auth-flow', 'login');

  // No credentials: there is nothing to restore. Signing in needs the server, and the sign-in pages already carry their own
  // warm-up experience (Issue #12), so this is not a waiting room.
  if (session.kind === 'none') return make('auth-flow', 'login');

  if (session.kind === 'unverified') {
    // Cannot be trusted without the server. Never the app, in any server state.
    if (server.kind === 'unavailable') return make('waiting-room', 'waiting-room', true);
    if (server.kind === 'checking') return make('checking-server', 'hold');
    // The server is back, but it cannot make an expired or mismatched local session valid again: sign in.
    return make('auth-flow', 'login');
  }

  // Trusted locally. Never blocked by the server: the app opens from local data.
  if (server.kind === 'unavailable') return make('offline-capable', 'app', true);
  if (server.kind === 'checking') return make('checking-server', 'app');
  return verdict === 'valid' ? make('normal-online', 'app') : make('revalidating', 'app');
}

/** The only states in which the server has confirmed this session and answered healthily. Offline can never be one of them. */
export const isConfirmedOnline = (decision: LaunchDecision): boolean => decision.state === 'normal-online';
