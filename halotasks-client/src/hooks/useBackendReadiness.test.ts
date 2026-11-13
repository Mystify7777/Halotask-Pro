import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthProbeResult } from '../services/healthService';
import { MAX_UNHEALTHY, RETRY_DELAY_MS, SLOW_PROBE_MS, WAKE_BUDGET_MS, useBackendReadiness } from './useBackendReadiness';

// Issue #12: readiness comes only from real probe answers. The probe is replaced; the hook, its timers and its state are real.
const probe = vi.hoisted(() => vi.fn<(signal?: AbortSignal) => Promise<HealthProbeResult>>());
vi.mock('../services/healthService', () => ({ probeBackendHealth: probe }));

const answers = (...results: HealthProbeResult[]) => {
  let call = 0;
  probe.mockImplementation(async () => results[Math.min(call++, results.length - 1)]);
};
const pending = () => probe.mockImplementation(() => new Promise<HealthProbeResult>(() => undefined));
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

const mount = () => {
  const phases: string[] = [];
  const hook = renderHook(() => {
    const state = useBackendReadiness();
    phases.push(state.phase);
    return state;
  });
  return { ...hook, phases };
};

beforeEach(() => {
  vi.useFakeTimers();
  probe.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a backend that is already awake', () => {
  it('goes straight to ready and never shows the warm-up (normal behaviour is untouched)', async () => {
    answers('ok');
    const { result, phases } = mount();
    await advance(0);
    expect(result.current.phase).toBe('ready');
    expect(phases).not.toContain('waking');
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(WAKE_BUDGET_MS);
    expect(probe).toHaveBeenCalledTimes(1); // and it stops asking
  });
});

describe('a cold start', () => {
  it('shows nothing until the first probe is slow, then waking, then ready only when a probe says ok', async () => {
    pending();
    const { result } = mount();
    expect(result.current.phase).toBe('checking');
    await advance(SLOW_PROBE_MS - 1);
    expect(result.current.phase).toBe('checking');
    await advance(1);
    expect(result.current.phase).toBe('waking');

    answers('ok');
    await advance(0);
    // the pending first probe never answered, so nothing has said ready yet
    expect(result.current.phase).toBe('waking');
  });

  it('keeps probing while nothing answers, and becomes ready the moment one probe is ok', async () => {
    answers('no-answer', 'no-answer', 'no-answer', 'ok');
    const { result } = mount();
    await advance(0);
    expect(result.current.phase).toBe('waking');
    await advance(RETRY_DELAY_MS);
    expect(result.current.phase).toBe('waking');
    await advance(RETRY_DELAY_MS);
    expect(result.current.phase).toBe('waking');
    await advance(RETRY_DELAY_MS);
    expect(result.current.phase).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(4);
  });

  it('no amount of waiting makes it ready by itself: with no answer, ten minutes later it is still not ready', async () => {
    pending();
    const { result, phases } = mount();
    await advance(10 * 60_000);
    expect(result.current.phase).toBe('waking');
    expect(phases).not.toContain('ready');
  });

  it('a probe that errors (network, gateway) is "still waking", not a failure and not ready', async () => {
    answers('no-answer');
    const { result, phases } = mount();
    await advance(WAKE_BUDGET_MS - RETRY_DELAY_MS * 2);
    expect(result.current.phase).toBe('waking');
    expect(phases).not.toContain('ready');
    expect(phases).not.toContain('error');
  });
});

describe('failures are told apart from a normal cold start', () => {
  it('nothing healthy within the wake budget is a "timeout" failure, and probing stops', async () => {
    answers('no-answer');
    const { result } = mount();
    await advance(WAKE_BUDGET_MS + RETRY_DELAY_MS);
    expect(result.current.phase).toBe('error');
    expect(result.current.reason).toBe('timeout');

    const calls = probe.mock.calls.length;
    await advance(5 * 60_000);
    expect(probe).toHaveBeenCalledTimes(calls);
  });

  it(`${MAX_UNHEALTHY} consecutive "up but unhealthy" answers are an "unhealthy" failure (not a timeout, not waking forever)`, async () => {
    answers('unhealthy');
    const { result } = mount();
    await advance(RETRY_DELAY_MS * MAX_UNHEALTHY);
    expect(result.current.phase).toBe('error');
    expect(result.current.reason).toBe('unhealthy');
    expect(probe).toHaveBeenCalledTimes(MAX_UNHEALTHY);
  });

  it('a database that recovers in time is ready: unhealthy answers below the limit are survivable', async () => {
    answers('unhealthy', 'unhealthy', 'ok');
    const { result, phases } = mount();
    await advance(RETRY_DELAY_MS * 2);
    expect(result.current.phase).toBe('ready');
    expect(phases).not.toContain('error');
  });

  it('only CONSECUTIVE unhealthy answers count: a no-answer in between resets the streak', async () => {
    answers('unhealthy', 'unhealthy', 'no-answer', 'unhealthy', 'unhealthy', 'ok');
    const { result, phases } = mount();
    await advance(RETRY_DELAY_MS * 5);
    expect(result.current.phase).toBe('ready');
    expect(phases).not.toContain('error');
  });

  it('retry starts a fresh wait: after a failure, one more check can end in ready', async () => {
    answers('unhealthy');
    const { result } = mount();
    await advance(RETRY_DELAY_MS * MAX_UNHEALTHY);
    expect(result.current.phase).toBe('error');

    answers('ok');
    act(() => result.current.retry());
    expect(result.current.phase).toBe('checking');
    expect(result.current.reason).toBeNull();
    await advance(0);
    expect(result.current.phase).toBe('ready');
  });
});

describe('the page lifecycle', () => {
  it('unmounting aborts the in-flight probe and stops all further probing', async () => {
    answers('no-answer');
    const { unmount } = mount();
    await advance(0);
    const signal = probe.mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    unmount();
    expect(signal.aborted).toBe(true);
    const calls = probe.mock.calls.length;
    await advance(WAKE_BUDGET_MS * 2);
    expect(probe).toHaveBeenCalledTimes(calls);
  });

  it('a fresh mount (a refresh, or navigating straight to the route) probes again from scratch', async () => {
    answers('ok');
    const first = mount();
    await advance(0);
    first.unmount();

    answers('no-answer', 'ok');
    const second = mount();
    await advance(0);
    expect(second.result.current.phase).toBe('waking');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('going offline while a probe is in flight aborts it and goes idle; coming back online starts a fresh probe that can reach ready', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    pending();
    const { result } = mount();
    await advance(0);
    const firstSignal = probe.mock.calls[0][0] as AbortSignal;
    expect(firstSignal.aborted).toBe(false);

    online.mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(firstSignal.aborted).toBe(true);
    expect(result.current.phase).toBe('idle');
    expect(result.current.reason).toBeNull();

    // nothing more is asked while offline, however long it lasts
    const callsWhileOffline = probe.mock.calls.length;
    await advance(WAKE_BUDGET_MS);
    expect(probe).toHaveBeenCalledTimes(callsWhileOffline);

    answers('ok');
    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    const freshSignal = probe.mock.calls[probe.mock.calls.length - 1][0] as AbortSignal;
    expect(freshSignal).not.toBe(firstSignal);
    expect(freshSignal.aborted).toBe(false);
    expect(result.current.phase).toBe('ready');
  });

  it('an answer that arrives AFTER the browser went offline is discarded: it cannot make the hook ready or failed', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true);
    let resolveLate: (result: HealthProbeResult) => void = () => undefined;
    probe.mockImplementationOnce(() => new Promise<HealthProbeResult>((resolve) => { resolveLate = resolve; }));
    const { result, phases } = mount();
    await advance(0);

    online.mockReturnValue(false);
    await act(async () => {
      window.dispatchEvent(new Event('offline'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe('idle');

    await act(async () => {
      resolveLate('ok'); // the aborted request's answer limps in anyway
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe('idle');
    expect(phases).not.toContain('ready');
  });

  it('probes one at a time: a probe that never answers is not overlapped by another, so no second request starts until it settles', async () => {
    pending();
    mount();
    await advance(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('while the browser is offline it does not probe or claim anything; coming online starts the check', async () => {
    const online = vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    answers('ok');
    const { result } = mount();
    await advance(WAKE_BUDGET_MS);
    expect(result.current.phase).toBe('idle');
    expect(probe).not.toHaveBeenCalled();

    online.mockReturnValue(true);
    await act(async () => {
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.phase).toBe('ready');
    expect(probe).toHaveBeenCalledTimes(1);
  });
});

describe('launch pacing (Issue #49): a custom gap and a background re-check, opt-in', () => {
  const pacing = (calls: number[] = []) => ({
    nextDelayMs: (n: number) => {
      calls.push(n);
      return 1_000 * n;
    },
    backgroundDelayMs: () => 30_000,
  });
  const mountPaced = (p: ReturnType<typeof pacing>) => {
    const phases: string[] = [];
    const hook = renderHook(() => {
      const s = useBackendReadiness(p);
      phases.push(s.phase);
      return s;
    });
    return { ...hook, phases };
  };

  it('asks the pacing for each gap with the count of unanswered probes (1, 2, 3...)', async () => {
    answers('no-answer', 'no-answer', 'no-answer', 'ok');
    const calls: number[] = [];
    const { result } = mountPaced(pacing(calls));
    await advance(0);
    await advance(1_000);
    await advance(2_000);
    await advance(3_000);
    expect(calls).toEqual([1, 2, 3]);
    expect(result.current.phase).toBe('ready');
  });

  it('after the wait ends in error it keeps checking in the background, stays in error (never waking), and recovers to ready', async () => {
    answers('no-answer');
    const { result, phases } = mountPaced(pacing());
    await advance(WAKE_BUDGET_MS + 20_000);
    expect(result.current.phase).toBe('error');
    const errorAt = phases.length;
    const before = probe.mock.calls.length;
    await advance(65_000);
    expect(probe.mock.calls.length).toBeGreaterThanOrEqual(before + 2);
    expect(phases.slice(errorAt)).not.toContain('waking');
    expect(phases.slice(errorAt)).not.toContain('checking');

    answers('ok');
    await advance(30_000);
    expect(result.current.phase).toBe('ready');
    const done = probe.mock.calls.length;
    await advance(5 * 60_000);
    expect(probe).toHaveBeenCalledTimes(done); // ready ends it
  });

  it('the background re-check keeps the cause current (timeout <-> unhealthy)', async () => {
    answers('no-answer');
    const { result } = mountPaced(pacing());
    await advance(WAKE_BUDGET_MS + 20_000);
    expect(result.current.reason).toBe('timeout');
    answers('unhealthy');
    await advance(30_000);
    expect(result.current.reason).toBe('unhealthy');
    expect(result.current.phase).toBe('error');
  });

  it('probes never overlap: a slow probe is never joined by another', async () => {
    let inFlight = 0;
    let peak = 0;
    probe.mockImplementation(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5_000));
      inFlight--;
      return 'no-answer';
    });
    mountPaced(pacing());
    await advance(5 * 60_000);
    expect(peak).toBe(1);
  });
});
