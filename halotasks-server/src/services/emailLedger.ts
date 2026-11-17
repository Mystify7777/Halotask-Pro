import type { Types } from 'mongoose';
import EmailDelivery, { EMAIL_DELIVERY_RETENTION_DAYS, type EmailDeliveryState } from '../models/EmailDelivery.model';

/**
 * The delivery ledger's operations (Issue #29): how an event is CLAIMED exactly once, and how its outcome is recorded.
 * Every decision is one conditional write against the unique (userId, eventKey) document, never a read followed by a
 * write, so two overlapping runs, a replayed run and a restarted process cannot both claim the same event.
 *
 *   claim:  no document          -> insert one as `claimed` (attempt 1)           -> you own it, send
 *           state `failed`       -> back to `claimed`, attempts + 1 (below the cap) -> you own it, send
 *           `claimed`, lease over -> the run that held it died mid-send: the message MAY have gone out, so it becomes
 *                                   `unknown` and is NOT retried
 *           anything else        -> someone else owns it or it is finished         -> do nothing
 *   settle: `claimed` -> `sent` | `failed` | `unknown`, only while still `claimed`.
 *
 * What this guarantees: one durable claim per (user, event); at most one delivery ATTEMPT in flight per event; and no
 * further attempt once an outcome was ambiguous (`unknown`), after a lost response or a restart. A definite failure may
 * be retried (up to MAX_ATTEMPTS). What it cannot guarantee: exactly-once delivery. It cannot know whether a provider that
 * timed out delivered the message (that is what `unknown` records), nor whether a provider that reported a definite
 * failure really did not accept it.
 */

export const LEASE_MS = 2 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export type LedgerKind = 'task' | 'digest';

export type ClaimResult =
  | { outcome: 'claimed'; attempt: number }
  /** Already processed, being processed, over its attempt budget, or lost to a restart. `state` is what the ledger holds. */
  | { outcome: 'exists'; state: EmailDeliveryState | 'gone' };

export type Settlement =
  | { state: 'sent'; provider: 'smtp' | 'brevo' }
  | { state: 'failed' | 'unknown'; code?: string };

/** The few model methods the ledger uses, so a test can supply a double without a database. */
export type EmailDeliveryModel = Pick<typeof EmailDelivery, 'updateOne' | 'findOneAndUpdate' | 'findOne' | 'countDocuments'>;

export type EmailLedger = {
  claim: (userId: string, eventKey: string, kind: LedgerKind, now: Date) => Promise<ClaimResult>;
  settle: (userId: string, eventKey: string, settlement: Settlement, now: Date) => Promise<void>;
  /**
   * Gives back a claim that was never sent (the daily cap was exceeded once the claim was counted): `claimed` ->
   * `failed`, attempts - 1, so the event stays due and a later run may claim it again. Only a still-`claimed` row moves.
   */
  release: (userId: string, eventKey: string, now: Date) => Promise<void>;
  /** Emails claimed (or finished) for this user since `since`: the figure the daily cap is checked against. */
  countRecent: (userId: string, since: Date) => Promise<number>;
};

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000;

export const createEmailLedger = (model: EmailDeliveryModel = EmailDelivery): EmailLedger => ({
  claim: async (userId, eventKey, kind, now) => {
    const key = { userId: userId as unknown as Types.ObjectId, eventKey };
    const leaseUntil = new Date(now.getTime() + LEASE_MS);

    // 1. First time this event is seen: the unique index makes exactly one concurrent caller the inserter.
    try {
      const inserted = await model.updateOne(
        key,
        {
          $setOnInsert: {
            kind,
            state: 'claimed',
            attempts: 1,
            claimedAt: now,
            leaseUntil,
            expireAt: new Date(now.getTime() + EMAIL_DELIVERY_RETENTION_DAYS * DAY_MS),
          },
        },
        { upsert: true },
      );
      if (inserted.upsertedCount === 1) return { outcome: 'claimed', attempt: 1 };
    } catch (error) {
      if (!isDuplicateKey(error)) throw error; // two upserts raced: the other one inserted; fall through as "exists"
    }

    // 2. A definite failure with attempts left: take it back for another try.
    const retried = await model.findOneAndUpdate(
      { ...key, state: 'failed', attempts: { $lt: MAX_ATTEMPTS } },
      { $set: { state: 'claimed', claimedAt: now, leaseUntil }, $inc: { attempts: 1 } },
      { new: true },
    );
    if (retried) return { outcome: 'claimed', attempt: retried.attempts };

    // 3. A claim whose lease ran out: its run died, and the message may have been sent. Never retried.
    await model.updateOne(
      { ...key, state: 'claimed', leaseUntil: { $lte: now } },
      { $set: { state: 'unknown', lastCode: 'LEASE_EXPIRED', settledAt: now } },
    );

    const current = await model.findOne(key).select('state').lean();
    return { outcome: 'exists', state: current ? (current.state as EmailDeliveryState) : 'gone' };
  },

  settle: async (userId, eventKey, settlement, now) => {
    const set: Record<string, unknown> = { state: settlement.state, settledAt: now };
    if (settlement.state === 'sent') set.provider = settlement.provider;
    else if (settlement.code) set.lastCode = settlement.code.slice(0, 80);

    // Only a still-`claimed` document is settled: a claim whose lease already expired (and became `unknown`) stays that way.
    await model.updateOne({ userId: userId as unknown as Types.ObjectId, eventKey, state: 'claimed' }, { $set: set });
  },

  release: async (userId, eventKey, now) => {
    await model.updateOne(
      { userId: userId as unknown as Types.ObjectId, eventKey, state: 'claimed' },
      { $set: { state: 'failed', lastCode: 'CAP_RELEASED', settledAt: now }, $inc: { attempts: -1 } },
    );
  },

  countRecent: (userId, since) =>
    model.countDocuments({
      userId: userId as unknown as Types.ObjectId,
      state: { $in: ['claimed', 'sent', 'unknown'] },
      claimedAt: { $gte: since },
    }),
});
