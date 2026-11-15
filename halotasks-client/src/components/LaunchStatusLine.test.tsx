import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('LaunchStatusLine: "Play while you wait" is the only way the game opens', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const value = (d: LaunchDecision, serverRecoveries = 0): LaunchContextValue => ({
    decision: d,
    readiness: { phase: 'error', reason: 'timeout', retry: vi.fn() },
    serverRecoveries,
  });
  const mount = (d: LaunchDecision, recoveries = 0) =>
    render(<LaunchContext.Provider value={value(d, recoveries)}><LaunchStatusLine /></LaunchContext.Provider>);
  const rerenderWith = (r: ReturnType<typeof mount>, d: LaunchDecision, recoveries = 0) =>
    r.rerender(<LaunchContext.Provider value={value(d, recoveries)}><LaunchStatusLine /></LaunchContext.Provider>);
  const dialog = () => screen.queryByRole('dialog', { name: 'Server loading' });
  const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it.each(['waking', 'timeout', 'unhealthy', 'browser-offline'] as const)('cause "%s": a button, and no game until it is pressed', async (cause) => {
    mount(decision('offline-capable', cause));
    await advance(60_000);
    expect(dialog()).toBeNull();
    expect(screen.getByRole('button', { name: 'Play while you wait' })).toBeInTheDocument();
  });

  it('nothing to wait for: no button, no game', () => {
    mount(decision('normal-online'));
    expect(screen.queryByRole('button', { name: 'Play while you wait' })).toBeNull();
    expect(dialog()).toBeNull();
  });

  it('the click opens the game OUTSIDE the live region, so the dialog is not announced as a status update', () => {
    mount(decision('offline-capable', 'waking'));
    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    expect(dialog()).toBeInTheDocument();
    expect(screen.getByRole('status').contains(dialog())).toBe(false);
    expect(screen.getByRole('button', { name: 'Play while you wait' })).toBeDisabled();
  });

  it('Escape closes it and focus goes back to the button; a change of cause does not reopen it', async () => {
    const r = mount(decision('offline-capable', 'waking'));
    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    fireEvent.keyDown(dialog()!, { key: 'Escape' });
    await advance(1_500);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Play while you wait' }));
    rerenderWith(r, decision('offline-capable', 'timeout'));
    rerenderWith(r, decision('offline-capable', 'unhealthy'));
    await advance(60_000);
    expect(dialog()).toBeNull();
  });

  it('while it is open, a flicker of the status (cause gone, no recovery) neither closes it nor claims "ready"', async () => {
    const r = mount(decision('offline-capable', 'waking'));
    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    rerenderWith(r, decision('checking-server')); // e.g. while "Check now" is running
    await advance(5_000);
    expect(dialog()).toBeInTheDocument();
    expect(screen.queryByText(/Server is ready/)).toBeNull();
    rerenderWith(r, decision('offline-capable', 'waking'));
    expect(dialog()).toBeInTheDocument();
  });

  it('a real recovery while it is open gives the "ready" beat and closes it', async () => {
    const r = mount(decision('offline-capable', 'waking'), 2);
    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    rerenderWith(r, decision('normal-online'), 3); // the recovery count moved
    await advance(1_000); // past the overlay's short entrance, inside its "ready" beat
    expect(screen.getByText(/Server is ready/)).toBeInTheDocument();
    // each phase of the overlay schedules the next one from an effect, so time moves in small steps
    for (let i = 0; i < 40 && dialog(); i += 1) await advance(100);
    expect(dialog()).toBeNull();
  });

  it('a recovery that happened BEFORE it was opened does not count: the baseline is taken at the click', async () => {
    const r = mount(decision('offline-capable', 'waking'), 5);
    fireEvent.click(screen.getByRole('button', { name: 'Play while you wait' }));
    rerenderWith(r, decision('offline-capable', 'timeout'), 5);
    await advance(5_000);
    expect(dialog()).toBeInTheDocument();
    expect(screen.queryByText(/Server is ready/)).toBeNull();
  });
});
