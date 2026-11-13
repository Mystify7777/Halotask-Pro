import { useCallback, useEffect, useRef, useState } from 'react';
import { probeBackendHealth } from '../services/healthService';

/**
 * Where the backend stands, as learned from real readiness probes (Issue #12). It needs no session, no user and no task
 * data, so it works on the login and register pages before anyone is signed in.
 *
 *  - 'idle'      nothing to wait for (the browser is offline; probing starts when it is back online)
 *  - 'checking'  the first probe is out and has not been slow yet: show nothing
 *  - 'waking'    a probe came back without a healthy answer, or the first one is slow: the backend is (probably) cold
 *  - 'ready'     a probe got `ok`. This is the ONLY way to get here; no timer ever declares the backend ready
 *  - 'error'     the wait ended without success, with a `reason` that tells the two failures apart
 */
export type BackendReadinessPhase = 'idle' | 'checking' | 'waking' | 'ready' | 'error';

/**
 *  - 'timeout'    nothing healthy answered within WAKE_BUDGET_MS: the host is down or unreachable, not just slow
 *  - 'unhealthy'  the backend itself answered MAX_UNHEALTHY probes in a row saying it cannot work (database down)
 */
export type BackendFailureReason = 'timeout' | 'unhealthy';

/** How long the first probe may be unanswered before the warm-up experience appears. A fast backend never shows it. */
export const SLOW_PROBE_MS = 1_500;
/**
 * Pause after each probe settles while the backend is not ready. A polling interval, not a readiness estimate. Probes are
 * sequential (never overlapped), so an unanswered probe, cut at HEALTH_PROBE_TIMEOUT_MS, stretches the gap to about 12 s.
 */
export const RETRY_DELAY_MS = 2_000;
/** The longest a cold start is waited out, checked when a probe settles (so reported at ~90 s, at most ~102 s). A free-tier host needs about a minute; past this it is treated as down. */
export const WAKE_BUDGET_MS = 90_000;
/** Consecutive "I am up but unhealthy" answers after which the backend is reported as failing, not waking. */
export const MAX_UNHEALTHY = 3;

type State = { phase: BackendReadinessPhase; reason: BackendFailureReason | null };

/**
 * How probes are paced (Issue #49). The default, `FIXED_PACING`, is exactly the Issue #12 behaviour: a fixed gap, and the
 * hook stops once the wait ends in 'error' (the sign-in pages offer a manual "Check again").
 * The app-wide launch provider passes its own pacing: a growing gap with jitter, and a slow background re-check after
 * 'error' so a server that comes back is noticed without a click. Probes stay sequential either way (one in flight).
 */
export type ReadinessPacing = {
  /** Gap before the next probe, given how many probes in a row have gone without a healthy answer (1 = after the first). */
  nextDelayMs: (unanswered: number) => number;
  /** After the wait has ended in 'error', keep checking at this gap instead of stopping. null: stop (the default). */
  backgroundDelayMs: (() => number) | null;
};

export const FIXED_PACING: ReadinessPacing = { nextDelayMs: () => RETRY_DELAY_MS, backgroundDelayMs: null };

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

export function useBackendReadiness(pacing: ReadinessPacing = FIXED_PACING): State & { retry: () => void } {
  // Read through a ref so a new object identity never restarts the probing; only the current pace matters.
  const pacingRef = useRef(pacing);
  pacingRef.current = pacing;
  const [state, setState] = useState<State>({ phase: 'checking', reason: null });
  const [runId, setRunId] = useState(0);
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  useEffect(() => {
    if (!online) {
      setState({ phase: 'idle', reason: null });
      return;
    }

    const controller = new AbortController();
    const startedAt = Date.now();
    let unhealthyStreak = 0;
    let slowTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const markWaking = () => setState((current) => (current.phase === 'checking' ? { phase: 'waking', reason: null } : current));
    const markError = (reason: BackendFailureReason) =>
      setState((current) => (current.phase === 'error' && current.reason === reason ? current : { phase: 'error', reason }));

    setState({ phase: 'checking', reason: null });
    // Only decides when the warm-up UI appears. It never decides that the backend is ready or has failed.
    slowTimer = setTimeout(markWaking, SLOW_PROBE_MS);

    void (async () => {
      let unanswered = 0;
      let failed = false; // the wait has ended in 'error'; only a background pacing keeps probing from here
      for (;;) {
        const result = await probeBackendHealth(controller.signal);
        if (controller.signal.aborted) return;

        if (result === 'ok') {
          clearTimeout(slowTimer);
          setState({ phase: 'ready', reason: null });
          return;
        }

        unanswered += 1;

        if (failed) {
          // Background re-check: stay in 'error' (never back to "waking"), keep the cause current.
          markError(result === 'unhealthy' ? 'unhealthy' : 'timeout');
        } else {
          unhealthyStreak = result === 'unhealthy' ? unhealthyStreak + 1 : 0;
          let failure: BackendFailureReason | null = null;
          if (unhealthyStreak >= MAX_UNHEALTHY) {
            failure = 'unhealthy';
          } else {
            markWaking();
            if (Date.now() - startedAt >= WAKE_BUDGET_MS) failure = 'timeout';
          }

          if (failure) {
            clearTimeout(slowTimer);
            markError(failure);
            failed = true;
          }
        }

        const { nextDelayMs, backgroundDelayMs } = pacingRef.current;
        if (failed && !backgroundDelayMs) return;
        const gap = failed && backgroundDelayMs ? backgroundDelayMs() : nextDelayMs(unanswered);

        await new Promise<void>((resolve) => {
          retryTimer = setTimeout(resolve, gap);
        });
        if (controller.signal.aborted) return;
      }
    })();

    return () => {
      controller.abort();
      clearTimeout(slowTimer);
      clearTimeout(retryTimer);
    };
  }, [runId, online]);

  const retry = useCallback(() => setRunId((current) => current + 1), []);

  return { ...state, retry };
}
