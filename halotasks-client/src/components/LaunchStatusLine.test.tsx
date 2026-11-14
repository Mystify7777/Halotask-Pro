import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LaunchContext, type LaunchContextValue } from '../launch/launchContext';
import type { LaunchDecision } from '../launch/launchState';
import LaunchStatusLine from './LaunchStatusLine';

const decision = (state: LaunchDecision['state'], unavailable: LaunchDecision['unavailable'] = null): LaunchDecision => ({
  state,
  access: 'app',
  unavailable,
  unverified: null,
});

const renderWith = (d: LaunchDecision, retry = vi.fn()) => {
  const value: LaunchContextValue = { decision: d, readiness: { phase: 'error', reason: 'timeout', retry }, serverRecoveries: 0 };
  return { retry, ...render(<LaunchContext.Provider value={value}><LaunchStatusLine /></LaunchContext.Provider>) };
};

describe('LaunchStatusLine live region (Issue #49, 49D)', () => {
  it('the polite status region exists even when there is nothing to say', () => {
    renderWith(decision('normal-online'));
    const region = screen.getByRole('status');
    expect(region.getAttribute('aria-live')).toBe('polite');
    expect(region.textContent).toBe('');
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('offline-capable: the message and "Check now" appear inside that same region', () => {
    const { retry } = renderWith(decision('offline-capable', 'timeout'));
    const region = screen.getByRole('status');
    expect(region.textContent).toMatch(/can't reach the server/i);
    fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('browser offline: a message, but no button that cannot help', () => {
    renderWith(decision('offline-capable', 'browser-offline'));
    expect(screen.getByRole('status').textContent).toMatch(/You're offline/);
    expect(screen.queryByRole('button', { name: 'Check now' })).toBeNull();
  });

  it('the region is the same element when the state changes (so the change is announced)', () => {
    const value = (d: LaunchDecision): LaunchContextValue => ({ decision: d, readiness: { phase: 'error', reason: 'timeout', retry: vi.fn() }, serverRecoveries: 0 });
    const { rerender } = render(<LaunchContext.Provider value={value(decision('normal-online'))}><LaunchStatusLine /></LaunchContext.Provider>);
    const before = screen.getByRole('status');
    rerender(<LaunchContext.Provider value={value(decision('offline-capable', 'waking'))}><LaunchStatusLine /></LaunchContext.Provider>);
    expect(screen.getByRole('status')).toBe(before);
    expect(before.textContent).toMatch(/waking up/);
  });
});
