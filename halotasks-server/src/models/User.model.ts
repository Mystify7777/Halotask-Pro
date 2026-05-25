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
    },
  },
  {
    timestamps: true,
  },
);

const User = model('User', userSchema);

export default User;