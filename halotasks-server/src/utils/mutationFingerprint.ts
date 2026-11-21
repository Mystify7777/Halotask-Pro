import crypto from 'node:crypto';

// A fingerprint of the exact change a mutation asks for (Issue #60). It is stored next to a mutation id on the task, so a
// retry of the same id with the SAME change is a replay, and the same id with a DIFFERENT change is refused instead of being
// silently dropped. Key order never matters: `{a:1,b:2}` and `{b:2,a:1}` are the same change.

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
};

export const fingerprintOf = (value: unknown): string =>
  crypto.createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex').slice(0, 32);
