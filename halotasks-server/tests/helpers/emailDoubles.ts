import type { EmailDeliveryModel } from '../../src/services/emailLedger';
import type { EmailService, EmailMessage, FallbackPolicy, SendResult } from '../../src/services/emailService';

/**
 * Strict in-memory stand-ins for the email tests (Issue #29). They model the operations the ledger relies on, each as ONE
 * atomic step (nothing yields between the match and the change), like MongoDB's single-document operations, and they
 * enforce the unique (userId, eventKey) index. They are doubles: they prove the ledger's LOGIC. That MongoDB itself
 * enforces the index and applies these operators the same way is covered by tests/emailDelivery.realmongo.test.ts, which
 * needs a database and does not run without one.
 */

export type DeliveryDoc = {
  userId: string;
  eventKey: string;
  kind: string;
  state: string;
  attempts: number;
  claimedAt: Date;
  leaseUntil: Date;
  expireAt: Date;
  provider?: string;
  lastCode?: string;
  settledAt?: Date;
};

type Filter = Record<string, unknown>;

const matches = (doc: Record<string, unknown>, filter: Filter): boolean =>
  Object.entries(filter).every(([field, condition]) => {
    const value = doc[field];
    if (condition !== null && typeof condition === 'object' && !(condition instanceof Date)) {
      const ops = condition as Record<string, unknown>;
      return Object.entries(ops).every(([op, operand]) => {
        if (op === '$lt') return (value as number) < (operand as number);
        if (op === '$lte') return (value as Date) <= (operand as Date);
        if (op === '$gte') return (value as Date) >= (operand as Date);
        if (op === '$in') return (operand as unknown[]).includes(value);
        throw new Error(`double: unsupported operator ${op}`);
      });
    }
    return value === condition;
  });

export const createEmailDeliveryDouble = () => {
  const docs: DeliveryDoc[] = [];
  const faults = { failSettle: false, failClaim: false, duplicateKeyOnNextUpsert: false };
  const log: string[] = [];

  const find = (filter: Filter) => docs.find((d) => matches(d as unknown as Record<string, unknown>, filter));

  const model = {
    updateOne: async (filter: Filter, update: Record<string, Record<string, unknown>>, options: { upsert?: boolean } = {}) => {
      await Promise.resolve();
      const settleFault = faults.failSettle && update.$set && 'settledAt' in update.$set && !('lastCode' in update.$set && update.$set.lastCode === 'LEASE_EXPIRED');
      if (settleFault) throw new Error('simulated write failure');
      if (faults.failClaim && update.$setOnInsert) throw new Error('simulated write failure');

      const existing = find(filter);
      if (existing) {
        if (update.$set) Object.assign(existing, update.$set);
        for (const [field, by] of Object.entries(update.$inc ?? {})) (existing as unknown as Record<string, number>)[field] += by as number;
        log.push('update');
        return { matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options.upsert) {
        if (faults.duplicateKeyOnNextUpsert) {
          faults.duplicateKeyOnNextUpsert = false;
          throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        }
        const doc = { ...(filter as object), ...(update.$setOnInsert ?? {}) } as unknown as DeliveryDoc;
        if (docs.some((d) => d.userId === doc.userId && d.eventKey === doc.eventKey)) throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
        docs.push(doc);
        log.push('insert');
        return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
      }
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    },
    findOneAndUpdate: async (filter: Filter, update: { $set?: Record<string, unknown>; $inc?: Record<string, number> }) => {
      await Promise.resolve();
      const doc = find(filter);
      if (!doc) return null;
      if (update.$set) Object.assign(doc, update.$set);
      for (const [field, by] of Object.entries(update.$inc ?? {})) (doc as unknown as Record<string, number>)[field] += by;
      return { ...doc };
    },
    findOne: (filter: Filter) => ({
      select: () => ({ lean: async () => { await Promise.resolve(); const doc = find(filter); return doc ? { state: doc.state } : null; } }),
    }),
    countDocuments: async (filter: Filter) => {
      await Promise.resolve();
      return docs.filter((d) => matches(d as unknown as Record<string, unknown>, filter)).length;
    },
  };

  return { model: model as unknown as EmailDeliveryModel, docs, faults, log };
};

export type SentMessage = { message: EmailMessage; policy: FallbackPolicy };

/** A recording EmailService whose next results are scripted. By default every send succeeds through SMTP. */
export const createEmailServiceDouble = (configured = true) => {
  const sent: SentMessage[] = [];
  const script: Array<SendResult | 'throw'> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const service: EmailService = {
    isConfigured: () => configured,
    send: async (message, policy) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await Promise.resolve();
        sent.push({ message, policy });
        const next = script.shift();
        if (next === 'throw') throw new Error('provider blew up');
        return next ?? { status: 'sent', provider: 'smtp' };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { service, sent, script, maxInFlight: () => maxInFlight };
};
