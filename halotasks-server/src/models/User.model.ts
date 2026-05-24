import { Schema, model } from 'mongoose';

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