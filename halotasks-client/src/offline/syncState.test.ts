import { describe, expect, it } from 'vitest';
import { deriveSyncState, type SyncFacts } from './syncState';

// Issue #58: the table of states. Every row of the transition contract is one case; the priority conflicts are explicit.

const facts = (over: Partial<SyncFacts> = {}): SyncFacts => ({
  online: true,
  pending: 0,
  draining: false,
  blocked: null,
  rejections: 0,
  confirmedAt: null,
  ...over,
});
const T = '2026-11-19T10:42:00.000Z';

describe('deriveSyncState', () => {
  it('just opened, nothing synchronized this session: no claim at all', () => {
    expect(deriveSyncState(facts()).kind).toBe('unverified');
  });

  it('synced only with a confirmation from this session and an empty queue; carries the time', () => {
    expect(deriveSyncState(facts({ confirmedAt: T }))).toMatchObject({ kind: 'synced', confirmedAt: T, pending: 0 });
  });

  it('a new local change makes "synced" impossible, whatever the earlier confirmation was', () => {
    expect(deriveSyncState(facts({ confirmedAt: T, pending: 1 })).kind).toBe('pending');
  });

  it('online with unsent work and no attempt running: pending (not synced yet)', () => {
    expect(deriveSyncState(facts({ pending: 3 }))).toMatchObject({ kind: 'pending', pending: 3 });
  });

  it('a drain running over queued work: syncing', () => {
    expect(deriveSyncState(facts({ pending: 2, draining: true })).kind).toBe('syncing');
  });

  it('a drain with nothing queued claims nothing (it is not "syncing 0 changes")', () => {
    expect(deriveSyncState(facts({ pending: 0, draining: true })).kind).toBe('unverified');
  });

  it('offline: stored on this device, with the count; the confirmation is not shown as current', () => {
    expect(deriveSyncState(facts({ online: false, pending: 2, confirmedAt: T }))).toMatchObject({ kind: 'offline', pending: 2 });
    expect(deriveSyncState(facts({ online: false, confirmedAt: T })).kind).toBe('offline');
  });

  it('offline outranks a stale blocked verdict about the past', () => {
    expect(deriveSyncState(facts({ online: false, pending: 2, blocked: 'unreachable' })).kind).toBe('offline');
  });

  describe('attention keeps "could not send" and "was refused" apart', () => {
    it('unreachable: stuck queue, online, no attempt running', () => {
      expect(deriveSyncState(facts({ pending: 2, blocked: 'unreachable' }))).toMatchObject({
        kind: 'attention',
        blocked: 'unreachable',
        rejected: 0,
        pending: 2,
      });
    });

    it('auth: its own reason, never merged into unreachable', () => {
      expect(deriveSyncState(facts({ pending: 2, blocked: 'auth' }))).toMatchObject({ kind: 'attention', blocked: 'auth', rejected: 0 });
    });

    it('a refusal alone: attention with no blocked reason, even with an empty queue', () => {
      expect(deriveSyncState(facts({ rejections: 1, confirmedAt: T }))).toMatchObject({ kind: 'attention', blocked: null, rejected: 1 });
    });

    it('both at once keep both facts', () => {
      expect(deriveSyncState(facts({ pending: 1, blocked: 'unreachable', rejections: 2 }))).toMatchObject({
        kind: 'attention',
        blocked: 'unreachable',
        rejected: 2,
      });
    });

    it('a retry in progress is syncing, not attention (the blocked verdict is about the previous attempt)', () => {
      expect(deriveSyncState(facts({ pending: 2, blocked: 'unreachable', draining: true })).kind).toBe('syncing');
    });

    it('a refusal outranks syncing and offline: the edit that did not stick is not hidden', () => {
      expect(deriveSyncState(facts({ pending: 2, draining: true, rejections: 1 })).kind).toBe('attention');
      expect(deriveSyncState(facts({ online: false, pending: 1, rejections: 1 })).kind).toBe('attention');
    });

    it('blocked with nothing left to send is not attention', () => {
      expect(deriveSyncState(facts({ pending: 0, blocked: 'unreachable', confirmedAt: T })).kind).toBe('synced');
    });
  });
});
