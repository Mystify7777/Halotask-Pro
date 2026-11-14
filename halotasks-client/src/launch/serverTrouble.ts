/**
 * Mid-session server loss (Issue #49, phase 49C). The readiness probe is the ONLY authority on whether the server is
 * usable; a failed API request is merely a reason to ask it again. So this module carries a "that request looked like the
 * server is unreachable" hint from the API client to the launch provider, and holds the one rule for acting on it. It never
 * changes the launch state itself.
 *
 * A single failure can be a flaky request, a cancelled one, or the person's own network. The policy therefore is:
 *   - act only while the shared probe says the server is ready (otherwise it is already checking, or already unavailable);
 *   - ask for ONE fresh probe, and no more than once per `TROUBLE_RECHECK_MIN_GAP_MS`, however many requests fail;
 *   - the probe's answer decides: healthy changes nothing (the launch state does not even flicker for a trusted session), a
 *     failed one runs the normal wake-up and then the slow background re-check.
 */
export const TROUBLE_RECHECK_MIN_GAP_MS = 30_000;

export type RecheckInput = {
  /** The shared probe's phase right now. */
  phase: string;
  now: number;
  /** When a trouble-triggered re-check last started, or null if none has. */
  lastRecheckAt: number | null;
};

export function shouldRecheckAfterTrouble({ phase, now, lastRecheckAt }: RecheckInput): boolean {
  if (phase !== 'ready') return false;
  if (!Number.isFinite(now)) return false;
  return lastRecheckAt === null || now - lastRecheckAt >= TROUBLE_RECHECK_MIN_GAP_MS || now < lastRecheckAt;
}

type Listener = () => void;
const listeners = new Set<Listener>();

/** Called by the API client when an authenticated request failed in a way that looks like an unreachable server. */
export function reportServerTrouble(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      /* an observer must never break the response path */
    }
  }
}

export function subscribeServerTrouble(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Whether a failed request looks like "the server cannot be reached", as opposed to "the server answered no":
 *   - no response at all (network error, timeout), unless the request was cancelled on purpose or the browser is offline
 *     (the offline path already owns that), or
 *   - a gateway answer (502, 503, 504): what a sleeping or crashed host's proxy returns.
 * Any other response (400, 401, 403, 404, 409, 500...) is the server speaking, so it is not trouble.
 */
export function looksLikeServerTrouble(error: { code?: string; response?: { status?: number } | undefined }, browserOnline: boolean): boolean {
  // A browser that is offline owns the failure (the offline path), whatever else it looks like.
  if (!browserOnline) return false;
  if (error.response) return error.response.status === 502 || error.response.status === 503 || error.response.status === 504;
  return error.code !== 'ERR_CANCELED';
}
