import { Schema, model, models } from 'mongoose';

/**
 * The durable record of one reminder or digest email (Issue #29): the idempotency ledger and the delivery log in one.
 * One document per (userId, eventKey), enforced by a UNIQUE index, so the database, not process memory, decides that an
 * event is processed once across retries, replayed scheduler runs, restarts and concurrent runs.
 *
 * It holds identity and outcome only: no recipient address, no subject, no body, no task title, no provider error text.
 * `lastCode` is a short provider code such as `smtp:ETIMEDOUT`.
 *
 * States (see services/emailLedger.ts for the transitions):
 *   claimed  a run has taken the event and is sending it (`leaseUntil` bounds how long that may take)
 *   sent     a provider accepted it
 *   failed   every provider DEFINITELY did not accept it: safe to try again, up to the attempt limit
 *   unknown  a provider MAY have accepted it (ambiguous failure, or a run died mid-send): NEVER retried
 * Documents expire by themselves (TTL on `expireAt`), long after any event window can reopen.
 */

export const EMAIL_DELIVERY_STATES = ['claimed', 'sent', 'failed', 'unknown'] as const;
export type EmailDeliveryState = (typeof EMAIL_DELIVERY_STATES)[number];
export const EMAIL_DELIVERY_RETENTION_DAYS = 30;

const emailDeliverySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    eventKey: { type: String, required: true, maxlength: 200 },
    kind: { type: String, enum: ['task', 'digest'], required: true },
    state: { type: String, enum: EMAIL_DELIVERY_STATES, required: true },
    attempts: { type: Number, required: true, default: 1, min: 1 },
    claimedAt: { type: Date, required: true },
    leaseUntil: { type: Date, required: true },
    provider: { type: String, enum: ['smtp', 'brevo'] },
    lastCode: { type: String, maxlength: 80 },
    settledAt: { type: Date },
    expireAt: { type: Date, required: true },
  },
  { timestamps: true },
);

emailDeliverySchema.index({ userId: 1, eventKey: 1 }, { unique: true });
emailDeliverySchema.index({ userId: 1, claimedAt: 1 });
emailDeliverySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

// Route tests reload the app with vi.resetModules() while mongoose keeps its
// registry, so a second evaluation of this file must reuse the compiled model.
const compile = () => model('EmailDelivery', emailDeliverySchema);
const EmailDelivery = (models.EmailDelivery as ReturnType<typeof compile> | undefined) ?? compile();

export default EmailDelivery;
