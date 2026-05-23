import { Schema, model } from 'mongoose';

/**
 * Stores one productivity snapshot per user per day.
 * The compound index on (userId + date) ensures upserts are fast and unique.
 * Old entries are NOT auto-deleted here — the client prunes to 7 days on read.
 */

const completedTaskSchema = new Schema(
  {
    taskId: { type: String, required: true },
    title: { type: String, required: true },
    estimatedMinutes: { type: Number, default: 0 },
  },
  { _id: false },
);

const dayHistorySchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    /** YYYY-MM-DD local date string supplied by the client */
    date: {
      type: String,
      required: true,
      match: /^\d{4}-\d{2}-\d{2}$/,
    },
    completedCount: { type: Number, default: 0 },
    workDoneMinutes: { type: Number, default: 0 },
    completedTasks: { type: [completedTaskSchema], default: [] },
  },
  { timestamps: true },
);

// One entry per user per day — upserts hit this index directly
dayHistorySchema.index({ userId: 1, date: 1 }, { unique: true });

export default model('DayHistory', dayHistorySchema);
