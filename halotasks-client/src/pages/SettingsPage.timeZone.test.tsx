import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #41 — the time zone section is part of the Settings page, between Appearance and Account, and the rest of
// the page is unchanged.

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../App', () => ({
  useTheme: () => ({
    theme: 'day',
    isOverridden: false,
    isAdaptive: true,
    setThemeOverride: vi.fn(),
    setAdaptive: vi.fn(),
    themes: [{ name: 'day', label: 'Day', emoji: '☀️', dotColor: '#fff', timeRange: '6am–6pm' }],
  }),
}));
vi.mock('../services/userService', () => ({
  userService: { getPreferences: vi.fn(async () => ({ timeZone: 'Asia/Kolkata' })), updatePreferences: vi.fn() },
}));
vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => {}),
  clearCachedAuthUser: vi.fn(async () => {}),
}));

import { useAuthStore } from '../store/authStore';
import SettingsPage from './SettingsPage';

beforeEach(() => {
  localStorage.clear();
  const token = `${btoa('{}')}.${btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 }))}.sig`;
  useAuthStore.getState().setAuth({ token, user: { id: 'a', name: 'Alice', email: 'a@x.test', timeZone: 'Asia/Kolkata' } });
});

describe('SettingsPage', () => {
  it('shows the time zone section between Appearance and Account', async () => {
    render(<SettingsPage />);

    const headings = screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent);
    expect(headings).toEqual(['Appearance', 'Time zone', 'Account']);
    expect(await screen.findByLabelText('Time zone for task times')).toBeInTheDocument();
  });

  it('keeps the existing appearance and account controls', () => {
    render(<SettingsPage />);

    expect(screen.getByLabelText('Adaptive theme')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });
});
