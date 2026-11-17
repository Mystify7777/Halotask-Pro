import { describe, expect, it } from 'vitest';
import { createEmailLedger, LEASE_MS, MAX_ATTEMPTS } from '../src/services/emailLedger';
import { createEmailDeliveryDouble } from './helpers/emailDoubles';

// Issue #29, section S4 — the delivery ledger's claim/settle logic against a strict in-memory double (atomic steps, a unique
// index). Proves the LOGIC. MongoDB's own index and operator behaviour is tests/emailDelivery.realmongo.test.ts (needs a
// database; not run in the sandbox).

const U = '665f1c2e9b1e8a00000000a1';
const V = '665f1c2e9b1e8a00000000b2';
const T0 = new Date('2026-10-05T09:00:00Z');
const later = (ms: number) => new Date(T0.getTime() + ms);

const setup = () => {
  const store = createEmailDeliveryDouble();
  return { ...store, ledger: createEmailLedger(store.model) };
};

describe('claim', () => {
  it('the first claim owns the event and records it as claimed with a lease', async () => {
    const { ledger, docs } = setup();
    expect(await ledger.claim(U, 'k1', 'task', T0)).toEqual({ outcome: 'claimed', attempt: 1 });
    expect(docs).toHaveLength(1);
    expect(docs[0]).toMatchObject({ userId: U, eventKey: 'k1', kind: 'task', state: 'claimed', attempts: 1 });
    expect(docs[0].leaseUntil.getTime()).toBe(T0.getTime() + LEASE_MS);
    expect(docs[0].expireAt.getTime()).toBeGreaterThan(T0.getTime() + 29 * 86_400_000);
  });

  it('the same event twice: the second claim does nothing (scheduler replay)', async () => {
    const { ledger, docs } = setup();
    await ledger.claim(U, 'k1', 'task', T0);
    expect(await ledger.claim(U, 'k1', 'task', later(1000))).toEqual({ outcome: 'exists', state: 'claimed' });
    expect(docs).toHaveLength(1);
  });

  it('exactly ONE of many concurrent claims wins', async () => {
    const { ledger, docs } = setup();
    const results = await Promise.all(Array.from({ length: 25 }, () => ledger.claim(U, 'race', 'task', T0)));
    expect(results.filter((r) => r.outcome === 'claimed')).toHaveLength(1);
    expect(docs).toHaveLength(1);
  });

  it('a lost insert race (duplicate key) is "exists", not an error', async () => {
    const { ledger, docs, faults } = setup();
    docs.push({ userId: U, eventKey: 'k1', kind: 'task', state: 'sent', attempts: 1, claimedAt: T0, leaseUntil: T0, expireAt: T0 });
    faults.duplicateKeyOnNextUpsert = true;
    expect(await ledger.claim(U, 'k1', 'task', later(1000))).toEqual({ outcome: 'exists', state: 'sent' });
  });

  it('a non-duplicate database error is not swallowed', async () => {
    const { ledger, faults } = setup();
    faults.failClaim = true;
    await expect(ledger.claim(U, 'k1', 'task', T0)).rejects.toThrow('simulated write failure');
  });

  it('users are isolated: the same key for another user is a different event', async () => {
    const { ledger, docs } = setup();
    expect((await ledger.claim(U, 'same', 'task', T0)).outcome).toBe('claimed');
    expect((await ledger.claim(V, 'same', 'task', T0)).outcome).toBe('claimed');
    expect(docs.map((d) => d.userId).sort()).toEqual([U, V]);
  });
});

describe('settle, retry and the attempt budget', () => {
  it('sent is final: a later claim finds it done', async () => {
    const { ledger, docs } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    await ledger.settle(U, 'k', { state: 'sent', provider: 'smtp' }, later(500));
    expect(docs[0]).toMatchObject({ state: 'sent', provider: 'smtp' });
    expect(await ledger.claim(U, 'k', 'task', later(60_000))).toEqual({ outcome: 'exists', state: 'sent' });
  });

  it('a definite failure can be retried, up to the attempt budget, then it stays failed', async () => {
    const { ledger, docs } = setup();
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      expect(await ledger.claim(U, 'k', 'task', later(attempt * 1000))).toEqual({ outcome: 'claimed', attempt });
      await ledger.settle(U, 'k', { state: 'failed', code: 'smtp:EAUTH' }, later(attempt * 1000 + 1));
    }
    expect(docs[0]).toMatchObject({ state: 'failed', attempts: MAX_ATTEMPTS, lastCode: 'smtp:EAUTH' });
    expect(await ledger.claim(U, 'k', 'task', later(99_000))).toEqual({ outcome: 'exists', state: 'failed' });
  });

  it('UNKNOWN is never retried (at-most-once for an ambiguous failure)', async () => {
    const { ledger } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    await ledger.settle(U, 'k', { state: 'unknown', code: 'smtp:ETIMEDOUT' }, later(10));
    for (let i = 1; i <= 5; i += 1) {
      expect(await ledger.claim(U, 'k', 'task', later(i * 600_000))).toEqual({ outcome: 'exists', state: 'unknown' });
    }
  });

  it('only a claimed event is settled: a settle after the fact changes nothing', async () => {
    const { ledger, docs } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    await ledger.settle(U, 'k', { state: 'sent', provider: 'smtp' }, later(1));
    await ledger.settle(U, 'k', { state: 'failed', code: 'x' }, later(2));
    expect(docs[0].state).toBe('sent');
  });

  it('stores a short code only, never anything longer than 80 characters', async () => {
    const { ledger, docs } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    await ledger.settle(U, 'k', { state: 'failed', code: 'x'.repeat(500) }, later(1));
    expect(docs[0].lastCode).toHaveLength(80);
  });
});

describe('restart and crash: a claim whose run died', () => {
  it('inside the lease the event still belongs to the run that holds it', async () => {
    const { ledger } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    expect(await ledger.claim(U, 'k', 'task', later(LEASE_MS - 1))).toEqual({ outcome: 'exists', state: 'claimed' });
  });

  it('after the lease the message MAY have been sent, so it becomes unknown and is never retried', async () => {
    const { ledger, docs } = setup();
    await ledger.claim(U, 'k', 'task', T0); // the process dies here
    expect(await ledger.claim(U, 'k', 'task', later(LEASE_MS + 1))).toEqual({ outcome: 'exists', state: 'unknown' });
    expect(docs[0]).toMatchObject({ state: 'unknown', lastCode: 'LEASE_EXPIRED' });
    expect(await ledger.claim(U, 'k', 'task', later(10 * LEASE_MS))).toEqual({ outcome: 'exists', state: 'unknown' });
  });

  it('a late settle from the run that was presumed dead cannot overwrite unknown', async () => {
    const { ledger, docs } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    await ledger.claim(U, 'k', 'task', later(LEASE_MS + 1)); // another run notices the dead lease
    await ledger.settle(U, 'k', { state: 'sent', provider: 'smtp' }, later(LEASE_MS + 5));
    expect(docs[0].state).toBe('unknown');
  });

  it('a settle that cannot be written leaves the event claimed, which then ages into unknown: never sent twice', async () => {
    const { ledger, docs, faults } = setup();
    await ledger.claim(U, 'k', 'task', T0);
    faults.failSettle = true;
    await expect(ledger.settle(U, 'k', { state: 'sent', provider: 'smtp' }, later(5))).rejects.toThrow();
    faults.failSettle = false;
    expect(docs[0].state).toBe('claimed');
    expect(await ledger.claim(U, 'k', 'task', later(LEASE_MS + 1))).toEqual({ outcome: 'exists', state: 'unknown' });
  });
});

describe('release (a claim given back by the daily cap)', () => {
  it('returns a claimed, unsent event to failed with its attempt not spent, so a later run can claim it again', async () => {
    const { ledger } = setup();
    expect(await ledger.claim(U, 'k', 'task', T0)).toEqual({ outcome: 'claimed', attempt: 1 });
    await ledger.release(U, 'k', T0);
    expect(await ledger.countRecent(U, new Date(T0.getTime() - 86_400_000))).toBe(0);
    expect(await ledger.claim(U, 'k', 'task', later(1))).toEqual({ outcome: 'claimed', attempt: 1 });
  });

  it('never moves a sent or unknown event, so a release cannot reopen a delivery', async () => {
    const { ledger } = setup();
    await ledger.claim(U, 'sent', 'task', T0);
    await ledger.settle(U, 'sent', { state: 'sent', provider: 'smtp' }, T0);
    await ledger.claim(U, 'unk', 'task', T0);
    await ledger.settle(U, 'unk', { state: 'unknown' }, T0);
    await ledger.release(U, 'sent', T0);
    await ledger.release(U, 'unk', T0);
    expect(await ledger.claim(U, 'sent', 'task', later(1))).toEqual({ outcome: 'exists', state: 'sent' });
    expect(await ledger.claim(U, 'unk', 'task', later(1))).toEqual({ outcome: 'exists', state: 'unknown' });
  });
});

describe('countRecent (the daily cap input)', () => {
  it('counts claimed, sent and unknown inside the window, not failed, not older, not other users', async () => {
    const { ledger } = setup();
    await ledger.claim(U, 'sent', 'task', T0);
    await ledger.settle(U, 'sent', { state: 'sent', provider: 'smtp' }, T0);
    await ledger.claim(U, 'unk', 'task', T0);
    await ledger.settle(U, 'unk', { state: 'unknown' }, T0);
    await ledger.claim(U, 'inflight', 'digest', T0);
    await ledger.claim(U, 'failed', 'task', T0);
    await ledger.settle(U, 'failed', { state: 'failed' }, T0);
    await ledger.claim(U, 'old', 'task', new Date(T0.getTime() - 2 * 86_400_000));
    await ledger.claim(V, 'other', 'task', T0);
    expect(await ledger.countRecent(U, new Date(T0.getTime() - 86_400_000))).toBe(3);
    expect(await ledger.countRecent(V, new Date(T0.getTime() - 86_400_000))).toBe(1);
  });
});
