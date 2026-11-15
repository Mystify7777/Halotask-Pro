import { describe, expect, it } from 'vitest';

// Guard for the cold-start game (claude/audit-cold-start-game.md). The invariant: waiting or being cold-started never by
// itself makes the Task Tapper visible; only a person's action does. The behaviour is tested through the real dashboard and
// waiting room; this scan keeps the OWNERSHIP from drifting: only the places whose trigger was reviewed may import the game,
// and the dashboard page and its sync hook may not grow a cold-start signal again.
const sources = import.meta.glob('/src/**/*.{ts,tsx}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const code = Object.entries(sources).filter(([path]) => !/\.test\.tsx?$/.test(path));

describe('the Task Tapper has reviewed owners only', () => {
  it('scans a meaningful number of files', () => {
    expect(code.length).toBeGreaterThan(50);
  });

  it('is imported only by the waiting room and the status line (a button), and the sign-in warm-up (the issue #12 experience)', () => {
    const importers = code
      .filter(([path, text]) => /from\s+'[^']*ColdStartOverlay'/.test(text) && !path.endsWith('/ColdStartOverlay.tsx'))
      .map(([path]) => path.replace('/src/', ''))
      .sort();
    expect(importers).toEqual(['components/BackendWarmup.tsx', 'components/LaunchStatusLine.tsx', 'pages/WaitingRoomPage.tsx']);
  });

  it.each(['/src/pages/DashboardPage.tsx', '/src/hooks/useDashboardSync.ts'])('%s has no cold-start overlay or phase', (path) => {
    const text = sources[path];
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/ColdStart/);
    expect(text).not.toMatch(/coldStart/);
  });

  it('the status line and the waiting room open the game only through the shared hook, from a click', () => {
    for (const path of ['/src/components/LaunchStatusLine.tsx', '/src/pages/WaitingRoomPage.tsx']) {
      const text = sources[path];
      expect(text).toMatch(/usePlayWhileYouWait/);
      // `play` is only ever wired to an onClick
      const uses = text.match(/\bplay\b/g) ?? [];
      expect(uses.length).toBeGreaterThan(0);
      expect(text).not.toMatch(/useEffect\([^)]*play\(/s);
    }
  });
});
