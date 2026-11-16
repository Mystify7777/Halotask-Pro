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

  // The scan looks for the NAME of the component, not for one import syntax. Every way of reaching it (a default or named
  // import, either quote style, `import()` / `lazy()`, `require`, or a re-export from another module) has to spell the module
  // name in the file that does it, so any of them lands in this list and fails unless the file is one of the reviewed owners.
  // A barrel that re-exports it is itself a mention, so it fails too. (Building the module path from strings would get past
  // a text scan; code review is the backstop for that, and there is no reason to do it.)
  const referencesModule = (text: string, name: string) => text.includes(name);
  const mentions = (name: string) => code.filter(([path, text]) => referencesModule(text, name) && !path.endsWith('/components/dashboard/ColdStartOverlay.tsx')).map(([path]) => path.replace('/src/', '')).sort();

  it('is mentioned only by the waiting room, the status line and the sign-in warm-up, each behind a "Play while you wait" button', () => {
    expect(mentions('ColdStartOverlay')).toEqual(['components/BackendWarmup.tsx', 'components/LaunchStatusLine.tsx', 'pages/WaitingRoomPage.tsx']);
  });

  it('the scan catches the import forms a developer could plausibly write', () => {
    const forms = [
      "import ColdStartOverlay from './dashboard/ColdStartOverlay';",
      'import ColdStartOverlay from "./dashboard/ColdStartOverlay";',
      "import { default as Overlay } from './dashboard/ColdStartOverlay';",
      "const Overlay = lazy(() => import('./dashboard/ColdStartOverlay'));",
      'const Overlay = require("./dashboard/ColdStartOverlay");',
      "export { default as Game } from './dashboard/ColdStartOverlay';",
      "export * from './ColdStartOverlay';",
    ];
    for (const form of forms) expect(referencesModule(form, 'ColdStartOverlay')).toBe(true);
    expect(referencesModule("import Other from './dashboard/TaskCard';", 'ColdStartOverlay')).toBe(false);
  });

  it('the overlay folder has no barrel that could re-export it under another name', () => {
    const barrels = Object.keys(sources).filter((path) => /\/components\/dashboard\/index\.tsx?$/.test(path));
    expect(barrels).toEqual([]);
  });

  it.each(['/src/pages/DashboardPage.tsx', '/src/hooks/useDashboardSync.ts'])('%s has no cold-start overlay or phase', (path) => {
    const text = sources[path];
    expect(text).toBeTruthy();
    expect(text).not.toMatch(/ColdStart/);
    expect(text).not.toMatch(/coldStart/);
  });

  const OWNERS = ['/src/components/LaunchStatusLine.tsx', '/src/pages/WaitingRoomPage.tsx', '/src/components/BackendWarmup.tsx'];

  it('every owner opens the game only through the shared hook, and renders it only while `playing`', () => {
    for (const path of OWNERS) {
      const text = sources[path];
      expect(text, path).toMatch(/usePlayWhileYouWait/);
      expect(text, path).toMatch(/\bplaying\s*&&\s*\(?\s*<ColdStartOverlay/);
      // nothing else decides that the overlay is shown: no state of its own, and `play` is never called from an effect
      expect(text, path).not.toMatch(/useState\([^)]*\)[^\n]*[Oo]verlay/);
      expect(text, path).not.toMatch(/set(Overlay|ColdStart|Game|Show)\w*\(true\)/);
      expect(text, path).not.toMatch(/useEffect\([^)]*play\(/s);
      expect(text, path).toMatch(/onClick=\{[^}]*\bplay\b/);
    }
  });

  it('the shared hook turns the game on in exactly one place: the `play` callback', () => {
    const text = sources['/src/hooks/usePlayWhileYouWait.ts'];
    expect(text.match(/setPlaying\(true\)/g)).toHaveLength(1);
    expect(text).toMatch(/const play = useCallback\(\(\) => setPlaying\(true\)/);
  });

  it('the guard itself knows which files own the overlay', () => {
    expect(OWNERS.map((path) => path.replace('/src/', '')).sort()).toEqual(mentions('ColdStartOverlay'));
  });
});
