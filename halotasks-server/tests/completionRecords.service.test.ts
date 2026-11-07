import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCompletionStore,
  installCompletionRecordMock,
  removeCompletionRecordMock,
  type CompletionStore,
} from './helpers/completionDoubles';

// Issue #47 — the completion-record service (utils/completionRecords.ts) against a strict in-memory double of the model
// that enforces the two unique indexes and applies every write atomically. Mongo-free. What a double cannot show (that the
// indexes exist in MongoDB, that the driver raises 11000 for them, real concurrency) is covered by
// completionRecord.realmongo.test.ts.

const USER = '665f1c2e9b1e8a00000000aa';
const OTHER = '665f1c2e9b1e8a00000000bb';
const TASK = '665f1c2e9b1e8a0012345678';
const NOW = new Date('2026-11-05T04:00:00Z');
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

let store: CompletionStore;
let svc: typeof import('../src/utils/completionRecords');

const event = (over: Record<string, unknown> = {}) => ({
  completionId: 'c1',
  taskId: TASK,
  titleSnapshot: 'Write report',
  estimatedMinutesSnapshot: 30,
  completedAt: new Date(NOW.getTime() - 10 * MIN),
  utcOffsetMinutes: 330,
  localDate: '2026-11-05',
  ...over,
});

const active = () => store.docs.filter((d) => d.status === 'active');
const byId = (id: string) => store.docs.find((d) => d.completionId === id);

beforeEach(async () => {
  vi.resetModules();
  store = createCompletionStore();
  installCompletionRecordMock(store);
  svc = await import('../src/utils/completionRecords.js');
});

afterEach(() => {
  removeCompletionRecordMock();
  vi.restoreAllMocks();
});

describe('recordCompletion', () => {
  it('stores one active, client-observed record with the receipt time kept separate', async () => {
    const result = await svc.recordCompletion(USER, event(), NOW);

    expect(result).toEqual({ outcome: 'recorded', completionId: 'c1' });
    expect(store.docs).toHaveLength(1);
    expect(store.docs[0]).toMatchObject({
      userId: USER,
      completionId: 'c1',
      taskId: TASK,
      titleSnapshot: 'Write report',
      estimatedMinutesSnapshot: 30,
      status: 'active',
      source: 'live',
      completedAtSource: 'client',
      utcOffsetMinutes: 330,
      localDate: '2026-11-05',
      receivedAt: NOW,
    });
    expect(store.docs[0].completedAt).toEqual(new Date(NOW.getTime() - 10 * MIN));
  });

  it('is idempotent: the same event again changes nothing', async () => {
    await svc.recordCompletion(USER, event(), NOW);
    const again = await svc.recordCompletion(USER, event(), new Date(NOW.getTime() + 5 * MIN));

    expect(again).toEqual({ outcome: 'duplicate', completionId: 'c1', status: 'active' });
    expect(store.docs).toHaveLength(1);
    expect(store.docs[0].receivedAt).toEqual(NOW); // the first receipt time stands
  });

  it('a retry of a REVOKED event reports it as a duplicate with its current status; it is never re-activated', async () => {
    await svc.recordCompletion(USER, event(), NOW);
    await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt: null }, NOW);

    const again = await svc.recordCompletion(USER, event(), NOW);

    expect(again).toEqual({ outcome: 'duplicate', completionId: 'c1', status: 'revoked' });
    expect(active()).toHaveLength(0);
  });

  it('refuses a completionId that already belongs to a DIFFERENT event (never merges two events)', async () => {
    await svc.recordCompletion(USER, event(), NOW);

    const otherTask = await svc.recordCompletion(USER, event({ taskId: 'other' }), NOW);
    const otherTime = await svc.recordCompletion(USER, event({ completedAt: new Date(NOW.getTime() - 20 * MIN) }), NOW);
    const otherOffset = await svc.recordCompletion(USER, event({ utcOffsetMinutes: -420 }), NOW);

    for (const result of [otherTask, otherTime, otherOffset]) {
      expect(result).toEqual({ outcome: 'rejected', code: 'COMPLETION_ID_REUSED' });
    }
    expect(store.docs).toHaveLength(1);
  });

  it('answers an already-stored event as a duplicate even after the window has moved past it', async () => {
    await svc.recordCompletion(USER, event({ completedAt: new Date(NOW.getTime() - 89 * DAY) }), NOW);
    const later = new Date(NOW.getTime() + 5 * DAY); // now 94 days old: outside the window

    const again = await svc.recordCompletion(USER, event({ completedAt: new Date(NOW.getTime() - 89 * DAY) }), later);

    expect(again.outcome).toBe('duplicate');
  });

  describe('event window: 90 days back, 5 minutes ahead, never rewritten', () => {
    it.each([
      ['10 minutes old', -10 * MIN, 'recorded'],
      ['30 days old', -30 * DAY, 'recorded'],
      ['89 days old', -89 * DAY, 'recorded'],
      ['exactly 90 days old', -90 * DAY, 'recorded'],
      ['91 days old', -91 * DAY, 'rejected'],
      ['3 minutes in the future', 3 * MIN, 'recorded'],
      ['exactly 5 minutes in the future', 5 * MIN, 'recorded'],
      ['6 minutes in the future', 6 * MIN, 'rejected'],
    ])('%s -> %s', async (_label, offsetMs, outcome) => {
      const completedAt = new Date(NOW.getTime() + offsetMs);
      const result = await svc.recordCompletion(USER, event({ completedAt }), NOW);

      expect(result.outcome).toBe(outcome);
      if (outcome === 'rejected') {
        expect(result.code).toBe('COMPLETION_TIME_OUT_OF_WINDOW');
        expect(store.docs).toHaveLength(0); // nothing stored, in particular nothing re-dated to now
      } else {
        expect(store.docs[0].completedAt).toEqual(completedAt); // preserved exactly
      }
    });

    it('a delayed offline completion keeps its ORIGINAL instant and local day; receivedAt shows the delay', async () => {
      // Completed 23:50 on Nov 1 in India (18:20Z), delivered on Nov 8 morning.
      const completedAt = new Date('2026-11-01T18:20:00Z');
      const received = new Date('2026-11-08T03:30:00Z');

      await svc.recordCompletion(USER, event({ completedAt, localDate: '2026-11-01' }), received);

      expect(store.docs[0]).toMatchObject({ localDate: '2026-11-01', completedAt, receivedAt: received });
    });
  });

  describe('one active completion per task: the winner is decided by the index', () => {
    it('complete, uncomplete, complete = two records, one active', async () => {
      await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);
      await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt: new Date(NOW.getTime() - MIN) }, NOW);
      const second = await svc.recordCompletion(USER, event({ completionId: 'c2', completedAt: new Date(NOW.getTime() - 5 * MIN) }), NOW);

      expect(second.outcome).toBe('recorded');
      expect(store.docs).toHaveLength(2);
      expect(byId('c1')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted' });
      expect(byId('c2')).toMatchObject({ status: 'active' });
      expect(active()).toHaveLength(1);
    });

    it('a second device completing an already-completed task is stored as revoked/superseded and never counted', async () => {
      await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);

      const loser = await svc.recordCompletion(USER, event({ completionId: 'c2', completedAt: new Date(NOW.getTime() - 2 * MIN) }), NOW);

      expect(loser).toEqual({ outcome: 'superseded', completionId: 'c2' });
      expect(byId('c1')).toMatchObject({ status: 'active' });
      expect(byId('c2')).toMatchObject({ status: 'revoked', revokedReason: 'superseded', revokedAt: null, revokeReceivedAt: NOW });
      expect(active()).toHaveLength(1);
    });

    it('a repeat of the superseded event is a duplicate, not another record', async () => {
      await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);
      await svc.recordCompletion(USER, event({ completionId: 'c2' }), NOW);

      const again = await svc.recordCompletion(USER, event({ completionId: 'c2' }), NOW);

      expect(again).toEqual({ outcome: 'duplicate', completionId: 'c2', status: 'revoked' });
      expect(store.docs).toHaveLength(2);
    });

    it('concurrent completions of one task by several devices: exactly one active, the rest superseded', async () => {
      const results = await Promise.all(
        ['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => svc.recordCompletion(USER, event({ completionId: id }), NOW)),
      );

      expect(active()).toHaveLength(1);
      expect(store.docs).toHaveLength(5);
      expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
      expect(results.filter((r) => r.outcome === 'superseded')).toHaveLength(4);
    });

    it('concurrent deliveries of the SAME event: one record, every call succeeds', async () => {
      const results = await Promise.all(Array.from({ length: 6 }, () => svc.recordCompletion(USER, event(), NOW)));

      expect(store.docs).toHaveLength(1);
      expect(results.every((r) => r.outcome === 'recorded' || r.outcome === 'duplicate')).toBe(true);
      expect(results.filter((r) => r.outcome === 'recorded')).toHaveLength(1);
    });

    it('a rival inserted between the existence check and the insert (same event) resolves to a duplicate, not an error', async () => {
      store.hooks.beforeCreate = async () => {
        store.hooks.beforeCreate = undefined;
        await svc.recordCompletion(USER, event(), NOW); // the same event arrives through the other endpoint meanwhile
      };

      const result = await svc.recordCompletion(USER, event(), NOW);

      expect(result.outcome).toBe('duplicate');
      expect(store.docs).toHaveLength(1);
    });

    it('the holder is revoked after the slot was found taken: the retry takes the slot', async () => {
      await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);
      // On the lookup of the current holder (the only find with status 'active'), revoke it first, as another request would.
      store.hooks.failFind = (filter) => {
        if (filter.status === 'active') {
          const holder = store.docs.find((d) => d.completionId === 'c1');
          if (holder) Object.assign(holder, { status: 'revoked', revokeReceivedAt: NOW, revokedReason: 'uncompleted' });
          store.hooks.failFind = undefined;
        }
        return null;
      };

      const result = await svc.recordCompletion(USER, event({ completionId: 'c2' }), NOW);

      expect(result.outcome).toBe('recorded');
      expect(byId('c2')).toMatchObject({ status: 'active' });
      expect(active()).toHaveLength(1);
    });

    it('is per user: the same completionId and the same task id for two accounts are two independent records', async () => {
      await svc.recordCompletion(USER, event(), NOW);
      const other = await svc.recordCompletion(OTHER, event(), NOW);

      expect(other.outcome).toBe('recorded');
      expect(store.docs).toHaveLength(2);
      expect(active()).toHaveLength(2);
    });
  });

  it('a local-* task id is stored exactly as received and never looked up', async () => {
    await svc.recordCompletion(USER, event({ taskId: 'local-1730000000000-ab12cd' }), NOW);

    expect(store.docs[0].taskId).toBe('local-1730000000000-ab12cd');
  });

  it('a database failure propagates (the request fails and the client retries the same event)', async () => {
    store.hooks.failCreate = () => new Error('simulated database failure');

    await expect(svc.recordCompletion(USER, event(), NOW)).rejects.toThrow('simulated database failure');
    expect(store.docs).toHaveLength(0);

    store.hooks.failCreate = undefined;
    expect((await svc.recordCompletion(USER, event(), NOW)).outcome).toBe('recorded'); // the retry converges
  });
});

describe('recordOwnedCompletion (the task already holds this completion)', () => {
  const server = (id: string) => ({ fidelity: 'server' as const, completionId: id, taskId: TASK, titleSnapshot: 'Write report', estimatedMinutesSnapshot: 30 });
  const client = (over: Record<string, unknown> = {}) => ({ fidelity: 'client' as const, ...event(over) });
  const owner = async () => true;
  const notOwner = async () => false;

  it('server fidelity: a lower-fidelity record, receipt time as completedAt, local day unknown', async () => {
    const result = await svc.recordOwnedCompletion(USER, server('srv-aaaaaaaaaaaaaaaaaaaaaaaa'), owner, NOW);

    expect(result).toEqual({ outcome: 'recorded', completionId: 'srv-aaaaaaaaaaaaaaaaaaaaaaaa' });
    expect(store.docs[0]).toMatchObject({
      status: 'active',
      source: 'live',
      completedAtSource: 'server',
      completedAt: NOW,
      receivedAt: NOW,
      utcOffsetMinutes: null,
      localDate: null,
    });
  });

  it('is idempotent by completionId', async () => {
    await svc.recordOwnedCompletion(USER, client(), owner, NOW);
    const again = await svc.recordOwnedCompletion(USER, client(), owner, NOW);

    expect(again).toEqual({ outcome: 'duplicate', completionId: 'c1', status: 'active' });
    expect(store.docs).toHaveLength(1);
  });

  it('the same id for different content is refused, nothing changes', async () => {
    await svc.recordOwnedCompletion(USER, client(), owner, NOW);
    const result = await svc.recordOwnedCompletion(USER, client({ taskId: 'other' }), owner, NOW);

    expect(result).toEqual({ outcome: 'rejected', code: 'COMPLETION_ID_REUSED' });
    expect(store.docs).toHaveLength(1);
  });

  it('a time outside the window is refused', async () => {
    const result = await svc.recordOwnedCompletion(USER, client({ completedAt: new Date(NOW.getTime() - 120 * DAY) }), owner, NOW);

    expect(result).toEqual({ outcome: 'rejected', code: 'COMPLETION_TIME_OUT_OF_WINDOW' });
    expect(store.docs).toHaveLength(0);
  });

  it('a stale holder of the slot is revoked by its exact id when this completion is the owner', async () => {
    await svc.recordOwnedCompletion(USER, client({ completionId: 'old' }), owner, NOW);

    const result = await svc.recordOwnedCompletion(USER, client({ completionId: 'new' }), owner, NOW);

    expect(result).toEqual({ outcome: 'recorded', completionId: 'new' });
    expect(byId('old')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted', revokedAt: null });
    expect(byId('new')?.status).toBe('active');
    expect(active()).toHaveLength(1);
  });

  it('when the slot is taken and the task no longer owns this completion, it is stored as revoked/superseded and the holder is untouched', async () => {
    await svc.recordOwnedCompletion(USER, client({ completionId: 'winner' }), owner, NOW);
    let calls = 0;
    // owner while deciding (first look), not the owner once a newer transition has committed
    const isOwner = async () => (calls++ , false);

    const result = await svc.recordOwnedCompletion(USER, client({ completionId: 'late' }), isOwner, NOW);

    expect(result).toEqual({ outcome: 'superseded', completionId: 'late' });
    expect(byId('late')).toMatchObject({ status: 'revoked', revokedReason: 'superseded' });
    expect(byId('winner')?.status).toBe('active');
  });

  it('re-checks ownership AFTER inserting: a record inserted after its task moved on is revoked by its own request', async () => {
    const result = await svc.recordOwnedCompletion(USER, client(), notOwner, NOW);

    expect(result.outcome).toBe('recorded');
    expect(byId('c1')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted' });
    expect(active()).toHaveLength(0);
  });

  it('a late replay of a completion the task no longer owns closes it if it is still active', async () => {
    await svc.recordOwnedCompletion(USER, client(), owner, NOW);

    const replay = await svc.recordOwnedCompletion(USER, client(), notOwner, NOW);

    expect(replay).toEqual({ outcome: 'duplicate', completionId: 'c1', status: 'revoked' });
    expect(byId('c1')?.status).toBe('revoked');
  });

  it('never re-activates a revoked record', async () => {
    await svc.recordOwnedCompletion(USER, client(), owner, NOW);
    await svc.revokeCompletion(USER, { completionId: 'c1', taskId: TASK, revokedAt: null }, NOW);

    const replay = await svc.recordOwnedCompletion(USER, client(), owner, NOW);

    expect(replay).toEqual({ outcome: 'duplicate', completionId: 'c1', status: 'revoked' });
    expect(active()).toHaveLength(0);
  });

  it('concurrent inserts of the same completion: one record', async () => {
    await Promise.all([1, 2, 3, 4].map(() => svc.recordOwnedCompletion(USER, client(), owner, NOW)));

    expect(store.docs).toHaveLength(1);
    expect(active()).toHaveLength(1);
  });
});

describe('inspectEvent', () => {
  it('classifies an event as new, stored (same content) or refused (reused id, outside the window)', async () => {
    expect(await svc.inspectEvent(USER, event(), NOW)).toEqual({ kind: 'new' });
    await svc.recordCompletion(USER, event(), NOW);

    expect(await svc.inspectEvent(USER, event(), NOW)).toEqual({ kind: 'stored' });
    expect(await svc.inspectEvent(USER, event({ taskId: 'other' }), NOW)).toEqual({ kind: 'refused', code: 'COMPLETION_ID_REUSED' });
    expect(await svc.inspectEvent(USER, event({ completionId: 'c2', completedAt: new Date(NOW.getTime() - 120 * DAY) }), NOW)).toEqual({
      kind: 'refused',
      code: 'COMPLETION_TIME_OUT_OF_WINDOW',
    });
  });
});

describe('recordSupersededCompletion (history only: a completion that lost the transition)', () => {
  it('stores it as revoked/superseded without touching the task slot, idempotently', async () => {
    await svc.recordCompletion(USER, event({ completionId: 'winner' }), NOW);

    const first = await svc.recordSupersededCompletion(USER, event({ completionId: 'loser' }), NOW);
    const again = await svc.recordSupersededCompletion(USER, event({ completionId: 'loser' }), NOW);

    expect(first).toEqual({ outcome: 'superseded', completionId: 'loser' });
    expect(again).toEqual({ outcome: 'duplicate', completionId: 'loser', status: 'revoked' });
    expect(byId('winner')?.status).toBe('active');
    expect(byId('loser')).toMatchObject({ status: 'revoked', revokedReason: 'superseded' });
  });
});

describe('revokeCompletion', () => {
  beforeEach(async () => {
    await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);
  });

  it('revokes exactly that record: it stays, as revoked, with the client time and the receipt time', async () => {
    const revokedAt = new Date(NOW.getTime() - MIN);

    const result = await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt }, NOW);

    expect(result).toEqual({ outcome: 'revoked', completionId: 'c1' });
    expect(store.docs).toHaveLength(1);
    expect(byId('c1')).toMatchObject({ status: 'revoked', revokedReason: 'uncompleted', revokedAt, revokeReceivedAt: NOW });
    expect(byId('c1')?.titleSnapshot).toBe('Write report'); // the snapshot is untouched
  });

  it('is idempotent', async () => {
    await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt: null }, NOW);
    const again = await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt: null }, new Date(NOW.getTime() + MIN));

    expect(again).toEqual({ outcome: 'already_revoked', completionId: 'c1' });
    expect(byId('c1')?.revokeReceivedAt).toEqual(NOW);
  });

  it('an id the account never recorded is not_found; nothing is invented', async () => {
    const result = await svc.revokeCompletion(USER, { completionId: 'nope', revokedAt: null }, NOW);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(store.docs).toHaveLength(1);
  });

  it("another account cannot revoke this account's record", async () => {
    const result = await svc.revokeCompletion(OTHER, { completionId: 'c1', revokedAt: null }, NOW);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(byId('c1')?.status).toBe('active');
  });

  it('refuses to revoke a completion that belongs to another task', async () => {
    const result = await svc.revokeCompletion(USER, { completionId: 'c1', taskId: 'other', revokedAt: null }, NOW);

    expect(result).toEqual({ outcome: 'rejected', code: 'COMPLETION_TASK_MISMATCH' });
    expect(byId('c1')?.status).toBe('active');
  });

  it('revokes only the exact id it is given: another active completion of the same task is never touched', async () => {
    await svc.recordCompletion(USER, event({ completionId: 'c2', taskId: 'task-b' }), NOW);

    const result = await svc.revokeCompletion(USER, { completionId: 'c1', taskId: TASK, revokedAt: null }, NOW);

    expect(result).toEqual({ outcome: 'revoked', completionId: 'c1' });
    expect(byId('c2')?.status).toBe('active');
    expect((await svc.revokeCompletion(USER, { completionId: 'c1', taskId: TASK, revokedAt: null }, NOW)).outcome).toBe('already_revoked');
  });

  it('a client revoke time outside the window is stored as unknown (null): the revocation still happens', async () => {
    const result = await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt: new Date(NOW.getTime() - 120 * DAY) }, NOW);

    expect(result.outcome).toBe('revoked');
    expect(byId('c1')).toMatchObject({ status: 'revoked', revokedAt: null, revokeReceivedAt: NOW });
  });

  it('never touches migrated records when revoking by task', async () => {
    store.docs.push({
      userId: USER,
      completionId: 'm1',
      taskId: 'legacy-task',
      status: 'active',
      source: 'migrated',
      completedAtSource: 'migrated',
    });

    const result = await svc.revokeCompletion(USER, { completionId: 'unknown-id', taskId: 'legacy-task', revokedAt: null }, NOW);

    expect(result).toEqual({ outcome: 'not_found' });
    expect(byId('m1')?.status).toBe('active');
  });
});

describe('discardJustRecorded (compensation for a task that is removed again)', () => {
  it('withdraws exactly the active record of that completion and task', async () => {
    await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);
    await svc.recordCompletion(USER, event({ completionId: 'c2', taskId: 'other' }), NOW);

    await svc.discardJustRecorded(USER, 'c1', TASK);

    expect(store.docs.map((d) => d.completionId)).toEqual(['c2']);
  });

  it('does not remove a revoked record, a record of another task, or another account\'s record', async () => {
    await svc.recordCompletion(USER, event({ completionId: 'c1' }), NOW);
    await svc.recordCompletion(OTHER, event({ completionId: 'c1' }), NOW);
    await svc.revokeCompletion(USER, { completionId: 'c1', revokedAt: null }, NOW);

    await svc.discardJustRecorded(USER, 'c1', TASK); // revoked: stays
    await svc.discardJustRecorded(OTHER, 'c1', 'other-task'); // wrong task: stays

    expect(store.docs).toHaveLength(2);
  });
});
