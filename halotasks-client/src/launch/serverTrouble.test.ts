import { describe, expect, it, vi } from 'vitest';
import { wantsServerReadiness } from './probeRoutes';
import {
  TROUBLE_RECHECK_MIN_GAP_MS,
  looksLikeServerTrouble,
  reportServerTrouble,
  shouldRecheckAfterTrouble,
  subscribeServerTrouble,
} from './serverTrouble';

describe('shouldRecheckAfterTrouble: a failed request only ever ASKS for one fresh probe', () => {
  const T = 1_000_000;
  it('only while the shared probe says ready', () => {
    for (const phase of ['dormant', 'idle', 'checking', 'waking', 'error']) {
      expect(shouldRecheckAfterTrouble({ phase, now: T, lastRecheckAt: null })).toBe(false);
    }
    expect(shouldRecheckAfterTrouble({ phase: 'ready', now: T, lastRecheckAt: null })).toBe(true);
  });

  it('at most once per minimum gap, however many requests fail', () => {
    expect(shouldRecheckAfterTrouble({ phase: 'ready', now: T + TROUBLE_RECHECK_MIN_GAP_MS - 1, lastRecheckAt: T })).toBe(false);
    expect(shouldRecheckAfterTrouble({ phase: 'ready', now: T + TROUBLE_RECHECK_MIN_GAP_MS, lastRecheckAt: T })).toBe(true);
  });

  it('a clock that went backwards or a broken clock cannot cause a storm or a stall', () => {
    expect(shouldRecheckAfterTrouble({ phase: 'ready', now: T - 5, lastRecheckAt: T })).toBe(true);
    expect(shouldRecheckAfterTrouble({ phase: 'ready', now: NaN, lastRecheckAt: null })).toBe(false);
  });
});

describe('looksLikeServerTrouble: "unreachable" is not "said no"', () => {
  it('no response at all is trouble while the browser is online', () => {
    expect(looksLikeServerTrouble({ code: 'ERR_NETWORK' }, true)).toBe(true);
    expect(looksLikeServerTrouble({ code: 'ECONNABORTED' }, true)).toBe(true);
  });
  it('but not when the browser is offline (the offline path owns that), nor when the request was cancelled on purpose', () => {
    expect(looksLikeServerTrouble({ code: 'ERR_NETWORK' }, false)).toBe(false);
    expect(looksLikeServerTrouble({ code: 'ERR_CANCELED' }, true)).toBe(false);
  });
  it('a gateway answer while the browser is offline is not trouble either', () => {
    for (const status of [502, 503, 504]) expect(looksLikeServerTrouble({ response: { status } }, false)).toBe(false);
  });
  it('gateway answers (502, 503, 504) are trouble', () => {
    for (const status of [502, 503, 504]) expect(looksLikeServerTrouble({ response: { status } }, true)).toBe(true);
  });
  it('every other answer is the server speaking, not trouble', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500, 501]) {
      expect(looksLikeServerTrouble({ response: { status } }, true)).toBe(false);
    }
  });
});

describe('the trouble signal', () => {
  it('reaches subscribers, stops after unsubscribe, and a throwing subscriber cannot break the caller', () => {
    const good = vi.fn();
    const off1 = subscribeServerTrouble(() => {
      throw new Error('boom');
    });
    const off2 = subscribeServerTrouble(good);
    expect(() => reportServerTrouble()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    off2();
    reportServerTrouble();
    expect(good).toHaveBeenCalledTimes(1);
    off1();
  });
});

describe('wantsServerReadiness: only pages that use the answer ask for it', () => {
  const none = { kind: 'none' } as const;
  it('an anonymous visitor probes only on the pages that talk to the server', () => {
    for (const path of ['/login', '/register', '/forgot-password', '/reset-password', '/login/']) {
      expect(wantsServerReadiness(path, none)).toBe(true);
    }
    for (const path of ['/', '/home', '/nowhere', '/dashboard']) expect(wantsServerReadiness(path, none)).toBe(false);
  });
  it('any session, trusted or not, probes everywhere', () => {
    expect(wantsServerReadiness('/home', { kind: 'trusted' })).toBe(true);
    expect(wantsServerReadiness('/dashboard', { kind: 'unverified', reason: 'no-stored-user' })).toBe(true);
  });
});
