import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackendFailureReason, BackendReadinessPhase } from '../hooks/useBackendReadiness';
import { getTokenUserId } from '../utils/authSession';
import {
  classifySession,
  deriveLaunchState,
  isConfirmedOnline,
  recordVerdict,
  serverStatusFrom,
  sessionKeyOf,
  verdictFor,
  type LaunchInputs,
  type ScopedVerdict,
  type ServerStatus,
  type SessionClass,
  type SessionVerdict,
} from './launchState';

// Issue #49, phase 49A: the launch decision as pure functions. No React, no timers, no network.

const NOW = new Date('2026-11-12T10:00:00Z');
const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const tokenFor = (claims: object) => `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64(claims)}.sig`;
const inSeconds = (offset: number) => Math.floor(NOW.getTime() / 1000) + offset;
const validToken = (userId = 'u1') => tokenFor({ userId, exp: inSeconds(3600) });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const TRUSTED: SessionClass = { kind: 'trusted' };
const NONE: SessionClass = { kind: 'none' };
const UNVERIFIED: SessionClass = { kind: 'unverified', reason: 'expired-or-malformed' };
const READY: ServerStatus = { kind: 'ready' };
const CHECKING: ServerStatus = { kind: 'checking' };
const DOWN: ServerStatus = { kind: 'unavailable', cause: 'waking' };
const decide = (session: SessionClass, server: ServerStatus, verdict: SessionVerdict = 'unknown') => deriveLaunchState({ session, server, verdict });

describe('classifySession: what "previously authenticated" means without the server', () => {
  const user = { id: 'u1' };

  it('trusted: a decodable, unexpired token AND a stored account whose id is the token\'s userId', () => {
    expect(classifySession({ token: validToken('u1'), user })).toEqual({ kind: 'trusted' });
  });

  it('no token is "none", whatever else is stored (a stored user alone is not a session)', () => {
    expect(classifySession({ token: null, user })).toEqual({ kind: 'none' });
    expect(classifySession({ token: null, user: null })).toEqual({ kind: 'none' });
  });

  it('an expired token is unverified, never trusted (also the moment it expires while the app is open)', () => {
    expect(classifySession({ token: tokenFor({ userId: 'u1', exp: inSeconds(-1) }), user })).toEqual({ kind: 'unverified', reason: 'expired-or-malformed' });
    vi.setSystemTime(new Date(NOW.getTime() + 2 * 3600 * 1000));
    expect(classifySession({ token: validToken('u1'), user }).kind).toBe('unverified');
  });

  it.each([
    ['not a JWT', 'garbage'],
    ['two segments, not JSON', 'a.b.c'],
    ['no exp claim', tokenFor({ userId: 'u1' })],
  ])('a malformed token is unverified: %s', (_name, token) => {
    expect(classifySession({ token, user })).toEqual({ kind: 'unverified', reason: 'expired-or-malformed' });
  });

  it('a valid token without a stored account is unverified (partial or damaged storage)', () => {
    expect(classifySession({ token: validToken('u1'), user: null })).toEqual({ kind: 'unverified', reason: 'no-stored-user' });
    expect(classifySession({ token: validToken('u1'), user: { id: '' } })).toEqual({ kind: 'unverified', reason: 'no-stored-user' });
  });

  it('a stored account that is not the one the token names is unverified (a stale or swapped half)', () => {
    expect(classifySession({ token: validToken('u1'), user: { id: 'someone-else' } })).toEqual({ kind: 'unverified', reason: 'identity-mismatch' });
    expect(classifySession({ token: tokenFor({ exp: inSeconds(3600) }), user })).toEqual({ kind: 'unverified', reason: 'identity-mismatch' }); // token names nobody
  });

  it('getTokenUserId reads only a string userId, and never throws', () => {
    expect(getTokenUserId(validToken('abc'))).toBe('abc');
    expect(getTokenUserId(tokenFor({ userId: 7, exp: inSeconds(10) }))).toBeNull();
    expect(getTokenUserId('garbage')).toBeNull();
    expect(getTokenUserId(null)).toBeNull();
  });
});

describe('classifySession: pathological tokens (the policy boundary must not trust a coerced or odd claim)', () => {
  const user = { id: 'u1' };
  const rawToken = (payloadJson: string) => `${b64({ alg: 'HS256' })}.${btoa(payloadJson).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.sig`;
  const expired = { kind: 'unverified', reason: 'expired-or-malformed' } as const;
  const future = inSeconds(3600);

  it.each([
    ['a numeric string that looks unexpired', `{"userId":"u1","exp":"${future}"}`],
    ['a string of digits far in the future', '{"userId":"u1","exp":"99999999999"}'],
    ['a one-element array holding a future number (coerces to a number)', `{"userId":"u1","exp":[${future}]}`],
    ['a one-element array holding a numeric string', `{"userId":"u1","exp":["${future}"]}`],
    ['exp: true', '{"userId":"u1","exp":true}'],
    ['exp: null', '{"userId":"u1","exp":null}'],
    ['exp: {}', '{"userId":"u1","exp":{}}'],
    ['exp: 0', '{"userId":"u1","exp":0}'],
    ['a negative exp', '{"userId":"u1","exp":-5}'],
    ['exp: 1e999 (parses to Infinity)', '{"userId":"u1","exp":1e999}'],
    ['exp: NaN (not valid JSON)', '{"userId":"u1","exp":NaN}'],
    ['exp: Infinity (not valid JSON)', '{"userId":"u1","exp":Infinity}'],
    ['a payload that is a number', '5'],
    ['a payload that is null', 'null'],
    ['a payload that is an array', '[]'],
    ['a payload that is a string', '"u1"'],
    ['an empty payload', ''],
  ])('is unverified: %s', (_name, payload) => {
    expect(classifySession({ token: rawToken(payload), user })).toEqual(expired);
  });

  it('exp is strictly in the future: the exact current second is expired, one second later is trusted', () => {
    expect(classifySession({ token: tokenFor({ userId: 'u1', exp: inSeconds(0) }), user })).toEqual(expired);
    expect(classifySession({ token: tokenFor({ userId: 'u1', exp: inSeconds(1) }), user })).toEqual({ kind: 'trusted' });
  });

  it('a fractional exp is compared as a number: just in the future is trusted, just past is expired', () => {
    expect(classifySession({ token: rawToken(`{"userId":"u1","exp":${inSeconds(0) + 0.5}}`), user })).toEqual({ kind: 'trusted' });
    expect(classifySession({ token: rawToken(`{"userId":"u1","exp":${inSeconds(0) - 0.5}}`), user })).toEqual(expired);
  });

  it.each([
    ['userId: ""', '""'],
    ['userId: null', 'null'],
    ['userId: a number', '123'],
    ['userId: an array', '["u1"]'],
    ['userId: an object', '{"id":"u1"}'],
  ])('a valid exp with %s does not match the stored account', (_name, userIdJson) => {
    const token = rawToken(`{"userId":${userIdJson},"exp":${future}}`);
    expect(classifySession({ token, user })).toEqual({ kind: 'unverified', reason: 'identity-mismatch' });
    expect(getTokenUserId(token)).toBeNull();
  });

  it('an empty token-side id never matches an empty stored id either', () => {
    expect(classifySession({ token: rawToken(`{"userId":"","exp":${future}}`), user: { id: '' } }).kind).toBe('unverified');
  });
});

describe('serverStatusFrom: the existing readiness phases, with the cause kept apart', () => {
  it.each<[BackendReadinessPhase, BackendFailureReason | null, ServerStatus]>([
    ['checking', null, { kind: 'checking' }],
    ['ready', null, { kind: 'ready' }],
    ['idle', null, { kind: 'unavailable', cause: 'browser-offline' }],
    ['waking', null, { kind: 'unavailable', cause: 'waking' }],
    ['error', 'timeout', { kind: 'unavailable', cause: 'timeout' }],
    ['error', 'unhealthy', { kind: 'unavailable', cause: 'unhealthy' }],
    ['error', null, { kind: 'unavailable', cause: 'timeout' }], // cannot happen from the hook; treated as the generic "could not reach it"
  ])('%s / %s', (phase, reason, expected) => {
    expect(serverStatusFrom(phase, reason)).toEqual(expected);
  });
});

describe('required cases', () => {
  it('1. server available + a trusted session the server confirmed: normal online launch', () => {
    const d = decide(TRUSTED, READY, 'valid');
    expect(d).toMatchObject({ state: 'normal-online', access: 'app', unavailable: null });
    expect(isConfirmedOnline(d)).toBe(true);
  });

  it('1b. ... while the server has not confirmed the session yet, it is revalidating (the app is not blocked)', () => {
    expect(decide(TRUSTED, READY, 'unknown')).toMatchObject({ state: 'revalidating', access: 'app' });
  });

  it('2. server unavailable + previously authenticated: the offline-capable app, with the cause', () => {
    for (const cause of ['browser-offline', 'waking', 'timeout', 'unhealthy'] as const) {
      expect(decide(TRUSTED, { kind: 'unavailable', cause })).toMatchObject({ state: 'offline-capable', access: 'app', unavailable: cause });
    }
  });

  it('2b. a trusted user is never held while the first probe is out', () => {
    expect(decide(TRUSTED, CHECKING)).toMatchObject({ state: 'checking-server', access: 'app' });
  });

  it('3. server unavailable + credentials that cannot be trusted: the waiting room, nothing protected', () => {
    expect(decide(UNVERIFIED, DOWN)).toMatchObject({ state: 'waiting-room', access: 'waiting-room', unavailable: 'waking', unverified: 'expired-or-malformed' });
  });

  it('3b. server unavailable + no credentials at all: the sign-in flow (its own #12 warm-up covers the wait), not the app', () => {
    expect(decide(NONE, DOWN)).toMatchObject({ state: 'auth-flow', access: 'login' });
  });

  it('4. each reason an untrusted session is held is carried through to the decision', () => {
    for (const reason of ['expired-or-malformed', 'no-stored-user', 'identity-mismatch'] as const) {
      expect(decide({ kind: 'unverified', reason }, DOWN)).toMatchObject({ state: 'waiting-room', unverified: reason });
    }
  });

  it('5. the server comes back while waiting: the waiting room ends by itself, into sign-in (the server cannot revive an expired session)', () => {
    expect(decide(UNVERIFIED, DOWN).state).toBe('waiting-room');
    expect(decide(UNVERIFIED, READY)).toMatchObject({ state: 'auth-flow', access: 'login' });
  });

  it('6. the server comes back while offline-capable: revalidation, then normal online (or sign-in when the server rejects the session)', () => {
    expect(decide(TRUSTED, DOWN).state).toBe('offline-capable');
    expect(decide(TRUSTED, READY, 'unknown').state).toBe('revalidating');
    expect(decide(TRUSTED, READY, 'valid').state).toBe('normal-online');
    expect(decide(TRUSTED, READY, 'invalid')).toMatchObject({ state: 'auth-flow', access: 'login' });
  });

  it('9. logout while waiting: with the credentials gone the decision is sign-in, whatever the server does', () => {
    expect(decide(UNVERIFIED, DOWN).state).toBe('waiting-room');
    for (const server of [CHECKING, READY, DOWN]) expect(decide(NONE, server)).toMatchObject({ state: 'auth-flow', access: 'login' });
  });

  it('10/11. a refresh or a direct visit asks the same question and gets the same answer (the decision is a pure function of its inputs)', () => {
    const inputs: LaunchInputs = { session: UNVERIFIED, server: DOWN, verdict: 'unknown' };
    expect(deriveLaunchState(inputs)).toEqual(deriveLaunchState({ ...inputs }));
    expect(deriveLaunchState(inputs)).toEqual(deriveLaunchState(structuredClone(inputs)));
  });

  it('a server-confirmed rejection ends the session whatever the health probe says', () => {
    for (const server of [CHECKING, READY, DOWN]) {
      expect(decide(TRUSTED, server, 'invalid')).toMatchObject({ state: 'auth-flow', access: 'login' });
    }
  });

  it('a pending first probe shows nothing protected to an untrusted session, and no alarm either', () => {
    expect(decide(UNVERIFIED, CHECKING)).toMatchObject({ state: 'checking-server', access: 'hold' });
  });
});

describe('checking-server has two meanings, told apart by access', () => {
  it('a trusted session keeps the app mounted; an untrusted one holds with nothing protected', () => {
    expect(decide(TRUSTED, CHECKING)).toMatchObject({ state: 'checking-server', access: 'app' });
    expect(decide(UNVERIFIED, CHECKING)).toMatchObject({ state: 'checking-server', access: 'hold' });
    expect(decide(UNVERIFIED, CHECKING).access).not.toBe(decide(TRUSTED, CHECKING).access);
  });

  it('every checking-server decision is one of those two, and never the sign-in or waiting screens', () => {
    const sessions: SessionClass[] = [NONE, TRUSTED, UNVERIFIED, { kind: 'unverified', reason: 'no-stored-user' }, { kind: 'unverified', reason: 'identity-mismatch' }];
    for (const session of sessions) {
      for (const verdict of ['unknown', 'valid'] as const) {
        const d = decide(session, CHECKING, verdict);
        if (d.state === 'checking-server') expect(d.access).toBe(session.kind === 'trusted' ? 'app' : 'hold');
      }
    }
  });
});

describe('a verdict belongs to one session (Issue #49: scoped verdicts)', () => {
  const A = validToken('user-a');
  const B = validToken('user-b');
  const keyA = sessionKeyOf(A);
  const keyB = sessionKeyOf(B);
  const invalidA: ScopedVerdict = { sessionKey: keyA!, verdict: 'invalid' };
  const validA: ScopedVerdict = { sessionKey: keyA!, verdict: 'valid' };
  const validB: ScopedVerdict = { sessionKey: keyB!, verdict: 'valid' };

  it('the key is the credential; no credential has no key', () => {
    expect(keyA).toBe(A);
    expect(keyA).not.toBe(keyB);
    expect(sessionKeyOf(null)).toBeNull();
    expect(sessionKeyOf('')).toBeNull();
  });

  it('A is rejected, A signs out: nothing is left (auth flow, no inherited verdict)', () => {
    expect(verdictFor(invalidA, keyA)).toBe('invalid');
    expect(verdictFor(invalidA, null)).toBe('unknown');
    expect(deriveLaunchState({ session: NONE, server: READY, verdict: verdictFor(invalidA, null) })).toMatchObject({ state: 'auth-flow', access: 'login' });
  });

  it('A is rejected, B signs in: B does NOT inherit the rejection', () => {
    expect(verdictFor(invalidA, keyB)).toBe('unknown');
    expect(deriveLaunchState({ session: TRUSTED, server: READY, verdict: verdictFor(invalidA, keyB) })).toMatchObject({ state: 'revalidating', access: 'app' });
  });

  it('a late answer for A cannot change B (valid or invalid), and B\'s own answer is kept', () => {
    let stored: ScopedVerdict | null = null;
    stored = recordVerdict(stored, invalidA, keyB); // A's slow 401 arrives while B is current
    expect(stored).toBeNull();
    expect(verdictFor(stored, keyB)).toBe('unknown');
    stored = recordVerdict(stored, validB, keyB);
    expect(verdictFor(stored, keyB)).toBe('valid');
    stored = recordVerdict(stored, invalidA, keyB); // another stale one
    expect(stored).toEqual(validB);
    stored = recordVerdict(stored, validA, keyB);
    expect(stored).toEqual(validB);
  });

  it('an answer that arrives after sign-out is dropped', () => {
    expect(recordVerdict(null, validA, null)).toBeNull();
    expect(recordVerdict(validA, invalidA, null)).toEqual(validA); // untouched, and it reads unknown anyway
    expect(verdictFor(validA, null)).toBe('unknown');
  });

  it('within one session a rejection is final: a late success for the same token is ignored', () => {
    expect(recordVerdict(invalidA, validA, keyA)).toEqual(invalidA);
    expect(recordVerdict(validA, invalidA, keyA)).toEqual(invalidA);
    expect(recordVerdict(null, validA, keyA)).toEqual(validA);
  });

  it('no stored verdict reads unknown', () => {
    expect(verdictFor(null, keyA)).toBe('unknown');
  });
});

describe('safety invariants over EVERY combination of inputs', () => {
  const sessions: SessionClass[] = [
    NONE,
    TRUSTED,
    { kind: 'unverified', reason: 'expired-or-malformed' },
    { kind: 'unverified', reason: 'no-stored-user' },
    { kind: 'unverified', reason: 'identity-mismatch' },
  ];
  const servers: ServerStatus[] = [
    CHECKING,
    READY,
    { kind: 'unavailable', cause: 'browser-offline' },
    { kind: 'unavailable', cause: 'waking' },
    { kind: 'unavailable', cause: 'timeout' },
    { kind: 'unavailable', cause: 'unhealthy' },
  ];
  const verdicts: SessionVerdict[] = ['unknown', 'valid', 'invalid'];
  const all = sessions.flatMap((session) => servers.flatMap((server) => verdicts.map((verdict) => ({ session, server, verdict }))));

  it('covers 90 combinations and every one gets a decision', () => {
    expect(all).toHaveLength(90);
    for (const inputs of all) expect(deriveLaunchState(inputs).state).toBeTruthy();
  });

  it('14. the app is shown ONLY to a session that is trusted locally and not rejected by the server', () => {
    for (const inputs of all) {
      if (deriveLaunchState(inputs).access === 'app') {
        expect(inputs.session.kind).toBe('trusted');
        expect(inputs.verdict).not.toBe('invalid');
      }
    }
  });

  it('15. offline or unavailable can never become the authenticated online state', () => {
    for (const inputs of all) {
      const d = deriveLaunchState(inputs);
      if (isConfirmedOnline(d)) {
        expect(inputs.server.kind).toBe('ready');
        expect(inputs.session.kind).toBe('trusted');
        expect(inputs.verdict).toBe('valid');
      }
      if (inputs.server.kind === 'unavailable') expect(d.state).not.toBe('normal-online');
    }
  });

  it('an untrusted session never reaches the app, in any server state', () => {
    for (const inputs of all.filter((i) => i.session.kind === 'unverified')) expect(deriveLaunchState(inputs).access).not.toBe('app');
  });

  it('the decision names its causes exactly when they apply', () => {
    for (const inputs of all) {
      const d = deriveLaunchState(inputs);
      expect(d.unavailable !== null).toBe(d.state === 'offline-capable' || d.state === 'waiting-room');
      expect(d.unverified !== null).toBe(inputs.session.kind === 'unverified');
    }
  });

  it('the same inputs always give the same decision', () => {
    for (const inputs of all) expect(deriveLaunchState(inputs)).toEqual(deriveLaunchState(structuredClone(inputs)));
  });
});
