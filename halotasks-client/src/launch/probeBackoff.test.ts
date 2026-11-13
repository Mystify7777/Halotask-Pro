import { describe, expect, it } from 'vitest';
import { BACKOFF_BASE_MS, BACKOFF_CAP_MS, BACKOFF_FLOOR_MS, BACKOFF_JITTER, probeDelayMs } from './probeBackoff';

// Issue #49, phase 49A: probe pacing is a pure function, so "bounded" and "no storm" are checked directly.

const lowest = () => 0;
const middle = () => 0.5;
const highest = () => 0.999999;

describe('probeDelayMs', () => {
  it('starts at the base delay and grows with every unanswered probe', () => {
    const delays = [1, 2, 3, 4, 5].map((n) => probeDelayMs(n, middle));
    expect(delays[0]).toBe(BACKOFF_BASE_MS);
    for (let i = 1; i < delays.length; i += 1) expect(delays[i]).toBeGreaterThan(delays[i - 1]);
  });

  it('never exceeds the cap (plus its jitter), however long the server stays down', () => {
    for (const n of [10, 50, 1_000, 1_000_000]) {
      expect(probeDelayMs(n, middle)).toBe(BACKOFF_CAP_MS);
      expect(probeDelayMs(n, highest)).toBeLessThanOrEqual(Math.round(BACKOFF_CAP_MS * (1 + BACKOFF_JITTER)));
    }
  });

  it('never goes below the floor: no tight loop whatever the random source returns', () => {
    for (let n = 1; n <= 30; n += 1) {
      for (const random of [lowest, middle, highest, () => -5, () => 7, () => Number.NaN]) {
        expect(probeDelayMs(n, random)).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
      }
    }
  });

  it('keeps jitter inside +-20% of the unjittered delay', () => {
    for (let n = 1; n <= 12; n += 1) {
      const mid = probeDelayMs(n, middle);
      expect(probeDelayMs(n, lowest)).toBeGreaterThanOrEqual(Math.round(mid * (1 - BACKOFF_JITTER)) - 1);
      expect(probeDelayMs(n, highest)).toBeLessThanOrEqual(Math.round(mid * (1 + BACKOFF_JITTER)) + 1);
    }
  });

  it('is deterministic for a given attempt and random source', () => {
    expect(probeDelayMs(4, () => 0.3)).toBe(probeDelayMs(4, () => 0.3));
  });

  it('treats a nonsense attempt as the first one instead of throwing or returning NaN', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 1.7]) {
      const delay = probeDelayMs(bad, middle);
      expect(Number.isFinite(delay)).toBe(true);
      expect(delay).toBeGreaterThanOrEqual(BACKOFF_FLOOR_MS);
    }
  });

  it('8. request volume stays bounded: over ten minutes of an unreachable server, probes number in the dozens, not hundreds', () => {
    let elapsed = 0;
    let probes = 0;
    while (elapsed < 10 * 60 * 1000) {
      probes += 1;
      elapsed += probeDelayMs(probes, lowest) + 10_000; // each probe may itself take up to its 10 s timeout
    }
    expect(probes).toBeLessThan(60);
  });
});
