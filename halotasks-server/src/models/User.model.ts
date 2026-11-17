import { Schema, model } from 'mongoose';
import { isValidTimeZone } from '../utils/timeZone';
import { BUFFER_MINUTES, HH_MM_PATTERN } from '../utils/emailReminderPrefs';

const pushSubscriptionSchema = new Schema(
  {
    endpoint: {
      type: String,
      required: true,
    },
    expirationTime: {
      type: Number,
      default: null,
    },
    keys: {
      p256dh: {
        type: String,
        required: true,
      },
      auth: {
        type: String,
        required: true,
      },
    },
  },
  {
    _id: false,
  },
);

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    // Session-generation counter. Every JWT carries the value it was issued under (`tv`) and
    // requireAuth accepts it only while it still equals this field, so incrementing it revokes every
    // token issued before. Bumped atomically with the password change on a successful reset.
    // Absent on accounts that predate it; absent is read as 0, as is a token with no `tv`.
    tokenVersion: {
      type: Number,
      default: 0,
    },
    // The user's chosen IANA time zone (Issue #41), used by the client to read a task's wall-clock due time and its
    // start time. Optional with NO default: an absent field means "no saved choice" and the client falls back to the
    // device's zone, so existing accounts need no migration and nothing ever writes a fallback here. Only the
    // preferences route sets or unsets it. Never part of the JWT.
    timeZone: {
      type: String,
      required: false,
      validate: {
        validator: (value: unknown) => value === undefined || value === null || isValidTimeZone(value),
        message: 'timeZone must be a valid IANA time zone identifier',
      },
    },
    resetPasswordTokenHash: {
      type: String,
      required: false,
    },
    resetPasswordExpiresAt: {
      type: Date,
      required: false,
    },
    pushSubscriptions: {
      type: [pushSubscriptionSchema],
      default: [],
    },
    // Email reminder preferences (Issue #29). Every field is optional with NO default: absent reads as the default in
    // utils/emailReminderPrefs.ts (email off), so existing accounts need no migration. Only the email-reminders
    // route writes it. Reminders are only ever sent to `email` above, never to an address from a request.
    emailReminders: {
      enabled: { type: Boolean },
      dueSoonEnabled: { type: Boolean },
      overdueEnabled: { type: Boolean },
      workSessionSoonEnabled: { type: Boolean },
      startNowEnabled: { type: Boolean },
      bufferMinutes: { type: Number, enum: BUFFER_MINUTES },
      quietHoursStart: { type: String, match: HH_MM_PATTERN },
      quietHoursEnd: { type: String, match: HH_MM_PATTERN },
      digestEnabled: { type: Boolean },
      digestTime: { type: String, match: HH_MM_PATTERN },
      timeZone: {
        type: String,
        validate: {
          validator: (value: unknown) => value === undefined || value === null || isValidTimeZone(value),
          message: 'timeZone must be a valid IANA time zone identifier',
        },
      },
    },
    treeState: {
      xp:               { type: Number,  default: 0 },
      leaves:           { type: Number,  default: 0 },
      streakDays:       { type: Number,  default: 0 },
      lastActiveDate:   { type: String,  default: null },
      health:           { type: String,  enum: ['healthy', 'wilting', 'dead'], default: 'healthy' },
      stage:            { type: String,  enum: ['seed', 'sprout', 'young', 'mature', 'lush'], default: 'seed' },
      lastCalculatedAt: { type: String,  default: () => new Date().toISOString() },
      awardedTaskIds:   { type: [String], default: [] },
      // Retained award-day history (Issue #16 AC8), server-internal and never returned or client-writable: the
      // UTC days (YYYY-MM-DD) on which a completion was awarded, one entry per day. It is the CANONICAL source of
      // the streak and last-active date; streakDays/lastActiveDate above are a materialised copy that may be
      // validated and repaired from it. Added with $addToSet in the SAME atomic update as the XP and the ledger
      // entry; capped at ACTIVE_DAYS_MAX and never truncated (a day that would not fit is refused). No default on
      // purpose: an absent field means "legacy tree, history not adopted yet" and the award adopts it first.
      activeDays: { type: [String], default: undefined },
      // Legacy recovery marker (Issue #24), no longer written. A tree that still carries one folds its days into
      // `activeDays` when it adopts the history, and the marker is removed in the same write.
      pendingDerivedDays: { type: [String], default: undefined },
    },
  },
  {
    timestamps: true,
  },
);

// The reminder run's only lookup: the accounts that opted in.
userSchema.index({ 'emailReminders.enabled': 1 }, { partialFilterExpression: { 'emailReminders.enabled': true } });

const User = model('User', userSchema);

export default User;