import { Schema, model } from 'mongoose';
import { DUE_TIME_PATTERN } from '../utils/taskValidators';

type UpdateShape = { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; dueDate?: unknown };

/**
 * A due time only exists next to a due date (Issue #10). This enforces what the schema can see:
 *  - on a document (create/save) the document's own dueDate must be present;
 *  - on an update (runValidators) it rejects an update that itself removes or nulls the dueDate while keeping a time.
 * It cannot see the STORED document when an update sets only dueTime, so that case is guarded by the controller, which
 * adds a `dueDate: { $exists: true, $ne: null }` filter to such updates. A write that bypasses both (updateOne with
 * no validators, bulk writes, `$unset: { dueDate }` on its own) is not protected by the schema.
 */
export function dueTimeNeedsDueDate(this: unknown, value: unknown): boolean {
  if (value === undefined || value === null) return true;
  const self = this as { getUpdate?: () => UpdateShape | null; dueDate?: unknown } | null;
  if (self && typeof self.getUpdate === 'function') {
    const update = self.getUpdate() ?? {};
    const set = update.$set ?? update;
    if (update.$unset && 'dueDate' in update.$unset) return false;
    if ('dueDate' in set && (set.dueDate === null || set.dueDate === undefined)) return false;
    return true;
  }
  return self?.dueDate !== undefined && self?.dueDate !== null;
}

const taskSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
      trim: true,
    },
    completed: {
      type: Boolean,
      default: false,
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    tags: {
      type: [String],
      default: [],
    },
    dueDate: {
      type: Date,
    },
    // Optional wall-clock time of day ("HH:mm") that goes with dueDate (Issue #10). Never set without a dueDate.
    dueTime: {
      type: String,
      match: DUE_TIME_PATTERN,
      validate: { validator: dueTimeNeedsDueDate, message: 'dueTime requires a dueDate' },
    },
    // Optional absolute instant the user intends to begin (Issue #9).
    startTime: {
      type: Date,
    },
    estimatedMinutes: {
      type: Number,
      default: 0,
    },
    reminderSent: {
      type: Boolean,
      default: false,
    },
    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

const Task = model('Task', taskSchema);

export default Task;
