import { useCallback, useEffect, useRef, useState } from 'react';

export type ThemeName = 'sunrise' | 'midday' | 'sunset' | 'night';

export interface ThemeConfig {
  name: ThemeName;
  label: string;
  emoji: string;
  hours: readonly number[];
  dotColor: string;
  timeRange: string;
}

export interface UseAdaptiveThemeReturn {
  theme: ThemeName;
  isOverridden: boolean;
  isAdaptive: boolean;
  setThemeOverride: (theme: ThemeName | null) => void;
  setAdaptive: (enabled: boolean) => void;
  themes: readonly ThemeConfig[];
}

export const THEMES: readonly ThemeConfig[] = [
  {
    name: 'sunrise',
    label: 'Sunrise',
    emoji: '🌅',
    hours: [5, 6, 7, 8, 9],
    dotColor: '#E8956D',
    timeRange: '5 AM - 10 AM',
  },
  {
    name: 'midday',
    label: 'Midday',
    emoji: '☀️',
    hours: [10, 11, 12, 13, 14, 15],
    dotColor: '#42A5F5',
    timeRange: '10 AM - 4 PM',
  },
  {
    name: 'sunset',
    label: 'Sunset',
    emoji: '🌇',
    hours: [16, 17, 18, 19, 20],
    dotColor: '#C2522A',
    timeRange: '4 PM - 9 PM',
  },
  {
    name: 'night',
    label: 'Night',
    emoji: '🌙',
    hours: [21, 22, 23, 0, 1, 2, 3, 4],
    dotColor: '#3949AB',
    timeRange: '9 PM - 5 AM',
  },
] as const;

const STORAGE_KEY_OVERRIDE = 'halotasks:theme_override';
const STORAGE_KEY_ADAPTIVE = 'halotasks:theme_adaptive';

export function getThemeForHour(hour: number): ThemeName {
  for (const theme of THEMES) {
    if (theme.hours.includes(hour)) {
      return theme.name;
    }
  }

  return 'sunrise';
}

export function getCurrentAutoTheme(): ThemeName {
  return getThemeForHour(new Date().getHours());
}

export function applyThemeToDocument(theme: ThemeName): void {
  document.documentElement.setAttribute('data-theme', theme);

  const metaThemeColors: Record<ThemeName, string> = {
    sunrise: '#C8623A',
    midday: '#1565C0',
    sunset: '#6D2610',
    night: '#0D0D22',
  };

  let metaThemeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!metaThemeColor) {
    metaThemeColor = document.createElement('meta');
    metaThemeColor.name = 'theme-color';
    document.head.appendChild(metaThemeColor);
  }

  metaThemeColor.content = metaThemeColors[theme];
}

export function useAdaptiveTheme(): UseAdaptiveThemeReturn {
  const [override, setOverrideState] = useState<ThemeName | null>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_OVERRIDE);
      if (stored && THEMES.some((theme) => theme.name === stored)) {
        return stored as ThemeName;
      }
    } catch {
      return null;
    }

    return null;
  });

  const [isAdaptive, setIsAdaptiveState] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY_ADAPTIVE);
      return stored !== 'false';
    } catch {
      return true;
    }
  });

  const [autoTheme, setAutoTheme] = useState<ThemeName>(getCurrentAutoTheme);

  const activeTheme: ThemeName = (() => {
    if (!isAdaptive && override) {
      return override;
    }

    if (!isAdaptive) {
      return autoTheme;
    }

    if (override) {
      return override;
    }

    return autoTheme;
  })();

  const isOverridden = override !== null;
  const prevThemeRef = useRef<ThemeName | null>(null);

  useEffect(() => {
    if (prevThemeRef.current === activeTheme) {
      return;
    }

    prevThemeRef.current = activeTheme;
    applyThemeToDocument(activeTheme);
  }, [activeTheme]);

  useEffect(() => {
    if (!isAdaptive || override) {
      return;
    }

    const tick = () => setAutoTheme(getCurrentAutoTheme());
    const intervalId = window.setInterval(tick, 60_000);
    return () => window.clearInterval(intervalId);
  }, [isAdaptive, override]);

  const setThemeOverride = useCallback((theme: ThemeName | null) => {
    setOverrideState(theme);
    try {
      if (theme) {
        localStorage.setItem(STORAGE_KEY_OVERRIDE, theme);
      } else {
        localStorage.removeItem(STORAGE_KEY_OVERRIDE);
        setAutoTheme(getCurrentAutoTheme());
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  const setAdaptive = useCallback((enabled: boolean) => {
    setIsAdaptiveState(enabled);
    try {
      localStorage.setItem(STORAGE_KEY_ADAPTIVE, enabled ? 'true' : 'false');
      if (enabled) {
        setAutoTheme(getCurrentAutoTheme());
      }
    } catch {
      // ignore storage errors
    }
  }, []);

  return {
    theme: activeTheme,
    isOverridden,
    isAdaptive,
    setThemeOverride,
    setAdaptive,
    themes: THEMES,
  };
}
