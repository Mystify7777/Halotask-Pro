import { describe, expect, it } from 'vitest';

// Guard for Issue #22: the browser bundle must never hold, read or call the AI provider directly.
// Every client source file is scanned as raw text. Needles are assembled from pieces so this file
// does not trip its own scan (it is excluded as well).
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<
  string,
  string
>;

const needles = [
  ['VITE', 'GROQ'].join('_'),
  ['GROQ', 'API', 'KEY'].join('_'),
  ['api', 'groq', 'com'].join('.'),
  ['gsk', ''].join('_'),
];

describe('client source contains no AI provider secret or direct provider call', () => {
  const files = Object.entries(sources).filter(([path]) => !path.endsWith('noClientSecrets.test.ts'));

  it('scans a meaningful number of files', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(needles)('has no reference to %s', (needle) => {
    const offenders = files.filter(([, text]) => text.includes(needle)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('reads only the known public VITE_ variables', () => {
    const vars = new Set<string>();
    for (const [, text] of files) {
      for (const match of text.matchAll(/import\.meta\.env\.(VITE_[A-Z0-9_]+)/g)) vars.add(match[1]);
    }
    // VAPID public key is public by design. Anything new here must be reviewed as a possible secret.
    expect([...vars].sort()).toEqual(['VITE_API_BASE_URL', 'VITE_VAPID_PUBLIC_KEY']);
  });
});
