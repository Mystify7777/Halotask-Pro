import { Schema, model } from 'mongoose';
import { localDateAt } from '../utils/calendarDate';
import { COMPLETION_ID_PATTERN } from '../utils/completionValidators';
import { MAX_TASK_ID_LENGTH, TASK_ID_PATTERN } from '../utils/historyValidators';
import { ESTIMATED_MINUTES_MAX, TITLE_MAX_LENGTH } from '../utils/taskValidators';

/**
 * One document per completion TRANSITION (Issue #47): task goes incomplete -> complete = one record. It is the
 * authoritative completion history. A Task document is current state only; DayHistory is legacy compatibility data.
 *
 * A record is created only from a validated completion event (utils/completionRecords.ts), never from a task snapshot.
 * It is immutable except for the revoke fields: titles and minutes are snapshots taken when the task was completed, so
 * a later rename or edit cannot change history, and deleting a task does not touch its records. Uncompleting REVOKES the
 * record (status 'revoked') instead of deleting it, so the history stays auditable and only 'active' records count.
 *
 * Fidelity of the time, recorded explicitly (`completedAtSource`):
 *   client    completedAt is the instant the user acted, observed by the client; offset and localDate are present.
 *   server    a legacy client sent no event data; completedAt is the server's receipt time and the user's calendar day is
 *             UNKNOWN (utcOffsetMinutes and localDate are null). Lower fidelity: analytics may exclude or qualify these.
 *   migrated  reconstructed from legacy DayHistory (later phase); the completion instant is unknown (completedAt null).
 *
 * localDate is DERIVED from completedAt + utcOffsetMinutes (never trusted on its own), enforced below.
 */

export const COMPLETION_STATUSES = ['active', 'revoked'] as const;
export const COMPLETION_REVOKE_REASONS = ['uncompleted', 'superseded'] as const;
export const COMPLETION_SOURCES = ['live', 'migrated'] as const;
export const COMPLETED_AT_SOURCES = ['client', 'server', 'migrated'] as const;

const completionRecordSchema = new Schema(
  {
    completionId: { type: String, required: true, match: COMPLETION_ID_PATTERN },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /**
     * Stored exactly as received. A `local-*` id (a task that never reached the server) is NOT a server task reference:
     * nothing resolves this value against the Task collection.
     */
    taskId: { type: String, required: true, match: TASK_ID_PATTERN, maxlength: MAX_TASK_ID_LENGTH },

    titleSnapshot: { type: String, required: true, maxlength: TITLE_MAX_LENGTH },
    estimatedMinutesSnapshot: { type: Number, required: true, min: 0, max: ESTIMATED_MINUTES_MAX },

    completedAt: { type: Date, default: null },
    // null is a legal value (a server-observed or migrated record has no known offset), and a custom validator DOES run
    // for null, so it must accept it explicitly.
    utcOffsetMinutes: {
      type: Number,
      default: null,
      min: -720,
      max: 840,
      validate: { validator: (value: unknown) => value === null || Number.isInteger(value), message: 'utcOffsetMinutes must be an integer' },
    },
    localDate: { type: String, default: null, match: /^\d{4}-\d{2}-\d{2}$/ },
    /** The server's clock when the record was written. Never client-supplied, never a substitute for completedAt. */
    receivedAt: { type: Date, required: true },

    status: { type: String, enum: COMPLETION_STATUSES, required: true, default: 'active' },
    /** Client-observed revoke time; null when the client sent none that was inside the window, or for a superseded event. */
    revokedAt: { type: Date, default: null },
    revokeReceivedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: [...COMPLETION_REVOKE_REASONS, null], default: null },

    source: { type: String, enum: COMPLETION_SOURCES, required: true, default: 'live' },
    completedAtSource: { type: String, enum: COMPLETED_AT_SOURCES, required: true },
  },
  { timestamps: false },
);

// The idempotency key: one event, one record, however many times (and through whichever endpoint) it is delivered.
completionRecordSchema.index({ userId: 1, completionId: 1 }, { unique: true, name: 'completion_id_per_user' });

// At most one ACTIVE live completion per task. This index, not a read-then-write, decides the winner when two devices
// complete the same task at once: the loser is stored as revoked/'superseded'. `source: 'live'` is in the filter so that
// migrated records (a task can appear on several legacy days) are never blocked by it.
completionRecordSchema.index(
  { userId: 1, taskId: 1 },
  { unique: true, partialFilterExpression: { status: 'active', source: 'live' }, name: 'one_active_live_completion_per_task' },
);

// Day, month and year queries (counts of active records by local day).
completionRecordSchema.index({ userId: 1, localDate: 1, status: 1 }, { name: 'completions_by_local_date' });
// Task-level history and debugging.
completionRecordSchema.index({ userId: 1, taskId: 1, completedAt: 1 }, { name: 'completions_by_task' });

// Cross-field rules, so no code path can store a record whose fields contradict each other.
completionRecordSchema.pre('validate', function () {
  const doc = this as unknown as {
    status: string;
    revokedReason: string | null;
    revokeReceivedAt: Date | null;
    revokedAt: Date | null;
    source: string;
    completedAtSource: string;
    completedAt: Date | null;
    utcOffsetMinutes: number | null;
    localDate: string | null;
    invalidate: (path: string, message: string) => void;
  };

  if (doc.status === 'active') {
    if (doc.revokedAt !== null || doc.revokeReceivedAt !== null || doc.revokedReason !== null) {
      doc.invalidate('status', 'an active completion cannot carry revoke fields');
    }
  } else if (doc.revokeReceivedAt === null || doc.revokedReason === null) {
    doc.invalidate('status', 'a revoked completion needs revokeReceivedAt and revokedReason');
  }

  if (doc.completedAtSource === 'client') {
    if (doc.source !== 'live') doc.invalidate('source', "completedAtSource 'client' requires source 'live'");
    if (doc.completedAt === null || doc.utcOffsetMinutes === null || doc.localDate === null) {
      doc.invalidate('completedAt', "completedAtSource 'client' requires completedAt, utcOffsetMinutes and localDate");
    } else if (doc.localDate !== localDateAt(doc.completedAt, doc.utcOffsetMinutes)) {
      doc.invalidate('localDate', 'localDate must equal the calendar date of completedAt at utcOffsetMinutes');
    }
  } else if (doc.completedAtSource === 'server') {
    if (doc.source !== 'live') doc.invalidate('source', "completedAtSource 'server' requires source 'live'");
    if (doc.completedAt === null) doc.invalidate('completedAt', "completedAtSource 'server' requires completedAt");
    if (doc.utcOffsetMinutes !== null || doc.localDate !== null) {
      doc.invalidate('localDate', "completedAtSource 'server' has no known local day: utcOffsetMinutes and localDate must be null");
    }
  } else if (doc.completedAtSource === 'migrated') {
    if (doc.source !== 'migrated') doc.invalidate('source', "completedAtSource 'migrated' requires source 'migrated'");
    if (doc.completedAt !== null) doc.invalidate('completedAt', "completedAtSource 'migrated' has an unknown completion instant (completedAt must be null)");
  }
});

export default model('CompletionRecord', completionRecordSchema);
