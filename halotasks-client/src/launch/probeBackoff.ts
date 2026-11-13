/**
 * How long to wait before the next readiness probe, as a pure function of how many probes have gone unanswered (Issue #49).
 * It only paces polling; it never decides that the server is ready or has failed. Probes stay sequential (one in flight),
 * so these gaps come on top of each probe's own time.
 *
 *   attempt 1: ~2 s, then growing by 1.6x to a ceiling of 15 s, with +-20% jitter so many tabs and devices do not
 *   probe in step. The floor is 1 s: no tight loop is possible whatever the random source returns.
 */
export const BACKOFF_BASE_MS = 2_000;
export const BACKOFF_FACTOR = 1.6;
export const BACKOFF_CAP_MS = 15_000;
export const BACKOFF_JITTER = 0.2;
export const BACKOFF_FLOOR_MS = 1_000;

/** `random` returns a number in [0, 1); injectable so the result is deterministic in tests. */
export function probeDelayMs(attempt: number, random: () => number = Math.random): number {
  const n = Number.isFinite(attempt) ? Math.max(1, Math.floor(attempt)) : 1;
  const raw = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * BACKOFF_FACTOR ** (n - 1));
  const sample = random();
  const r = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5; // a broken random source must not break the pacing
  const jittered = raw * (1 + (r * 2 - 1) * BACKOFF_JITTER);
  return Math.max(BACKOFF_FLOOR_MS, Math.round(jittered));
}

/** After the wait has ended in 'error', how often the launch provider quietly re-checks in the background. */
export const BACKGROUND_BASE_MS = 30_000;

/** ~30 s with the same +-20% jitter. One probe in flight at a time, so the server sees at most about two requests a minute per tab. */
export function backgroundProbeDelayMs(random: () => number = Math.random): number {
  const sample = random();
  const r = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0.5;
  return Math.round(BACKGROUND_BASE_MS * (1 + (r * 2 - 1) * BACKOFF_JITTER));
}
