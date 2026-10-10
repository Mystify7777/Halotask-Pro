import { Schema, model } from 'mongoose';

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
    treeState: {
      xp:               { type: Number,  default: 0 },
      leaves:           { type: Number,  default: 0 },
      streakDays:       { type: Number,  default: 0 },
      lastActiveDate:   { type: String,  default: null },
      health:           { type: String,  enum: ['healthy', 'wilting', 'dead'], default: 'healthy' },
      stage:            { type: String,  enum: ['seed', 'sprout', 'young', 'mature', 'lush'], default: 'seed' },
      lastCalculatedAt: { type: String,  default: () => new Date().toISOString() },
      awardedTaskIds:   { type: [String], default: [] },
      // Recovery marker (Issue #24), server-internal and never returned or client-writable: the UTC days
      // (YYYY-MM-DD) of awards whose streak/derived write is not persisted yet. Added with $addToSet in the
      // same atomic update as the XP award, removed ($unset) by the derived write that covers them. Absent
      // (no default, so no empty array) = nothing pending. One entry per distinct day, so it grows by at
      // most one per day of consecutive failures and every successful award clears it.
      pendingDerivedDays: { type: [String], default: undefined },
    },
  },
  {
    timestamps: true,
  },
);

const User = model('User', userSchema);

export default User;