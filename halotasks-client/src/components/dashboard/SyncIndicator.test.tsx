import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import SyncIndicator from './SyncIndicator';
import type { SyncState } from '../../offline/syncState';

// Issue #58: the wording says only what the state can prove.

const state = (over: Partial<SyncState>): SyncState => ({ kind: 'unverified', pending: 0, rejected: 0, blocked: null, confirmedAt: null, ...over });
const mount = (s: SyncState, rejections: { message: string; count: number }[] = [], retrying = false) => {
  const onRetry = vi.fn();
  const onDismiss = vi.fn();
  render(<SyncIndicator state={s} rejections={rejections} retrying={retrying} onRetry={onRetry} onDismiss={onDismiss} />);
  return { onRetry, onDismiss };
};

describe('SyncIndicator', () => {
  it('unverified: nothing is said', () => {
    mount(state({}));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('synced: says synced with a time, and nothing about changes', () => {
    mount(state({ kind: 'synced', confirmedAt: '2026-11-19T10:42:00.000Z' }));
    expect(screen.getByRole('status')).toHaveTextContent(/^Synced \d/);
  });

  it('pending: not synced yet, with Sync now', async () => {
    const { onRetry } = mount(state({ kind: 'pending', pending: 2 }));
    expect(screen.getByRole('status')).toHaveTextContent('2 changes not synced yet');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sync now' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('singular', () => {
    mount(state({ kind: 'pending', pending: 1 }));
    expect(screen.getByRole('status')).toHaveTextContent('1 change not synced yet');
  });

  it('syncing: names the count, offers no button', () => {
    mount(state({ kind: 'syncing', pending: 2 }));
    expect(screen.getByRole('status')).toHaveTextContent('Syncing 2 changes…');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offline with work: stored on this device, no retry that cannot work; without work: just Offline', () => {
    mount(state({ kind: 'offline', pending: 2 }));
    expect(screen.getByRole('status')).toHaveTextContent('Offline. 2 changes stored on this device.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('offline with nothing queued', () => {
    mount(state({ kind: 'offline' }));
    expect(screen.getByRole('status')).toHaveTextContent(/^Offline$/);
  });

  it('attention/unreachable: says the work is kept and offers Retry (not Dismiss)', async () => {
    const { onRetry } = mount(state({ kind: 'attention', pending: 2, blocked: 'unreachable' }));
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t sync with the server. 2 changes kept on this device.');
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('attention/unreachable (also the fallback for an unclassified drain error) always shows Retry', () => {
    mount(state({ kind: 'attention', pending: 3, blocked: 'unreachable' }));
    expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
  });

  it('attention/auth: asks to sign in again, with no Retry that cannot work', () => {
    mount(state({ kind: 'attention', pending: 1, blocked: 'auth' }));
    expect(screen.getByRole('status')).toHaveTextContent('Sign in again to sync 1 change.');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('attention/rejected: shows the refusal and a Dismiss; no Retry (retrying a refusal is pointless)', async () => {
    const { onDismiss } = mount(state({ kind: 'attention', rejected: 1 }), [{ message: 'Not saved: the server rejected the edit to “X” (error 400).', count: 1 }]);
    expect(screen.getByRole('status')).toHaveTextContent('Not saved: the server rejected the edit to “X”');
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('both facts at once are both shown, separately', () => {
    mount(state({ kind: 'attention', rejected: 1, pending: 2, blocked: 'unreachable' }), [{ message: 'Not saved: refused.', count: 1 }]);
    const text = screen.getByRole('status').textContent;
    expect(text).toContain('Not saved: refused.');
    expect(text).toContain('Couldn’t sync with the server');
  });

  it('retry in progress disables the button', () => {
    mount(state({ kind: 'attention', pending: 1, blocked: 'unreachable' }), [], true);
    expect(screen.getByRole('button', { name: 'Retrying...' })).toBeDisabled();
  });
});
