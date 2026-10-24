import { Error as MongooseError, Query, Schema, model } from 'mongoose';
import { DUE_TIME_PATTERN } from '../utils/taskValidators';

type UpdateShape = { $set?: Record<string, unknown>; $unset?: Record<string, unknown>; dueDate?: unknown };

export const DUE_TIME_NEEDS_DUE_DATE_MESSAGE = 'dueTime requires a dueDate';

/**
 * The deadline invariant (Issues #10, #44): a task never persists a `dueTime` without a `dueDate`.
 *
 * It is kept in this model so every Mongoose write goes through it, not only the task controller:
 *  - documents (`create`, `save`, `insertMany`): `pre('validate')` and `pre('save')` below, which also run for an
 *    UNMODIFIED dueTime and when validation is switched off with `validateBeforeSave: false`;
 *  - updates (`findOneAndUpdate`, `updateOne`, `updateMany`, and `bulkWrite` update ops): `guardDeadlineUpdate`;
 *  - replacements (`replaceOne`, `findOneAndReplace`, `bulkWrite` replace ops) and raw inserts (`bulkWrite` insertOne,
 *    `insertMany`, including `skipValidation` and `lean`, and `bulkSave`): the document itself is checked, so the rule
 *    does not depend on Mongoose validation being enabled.
 * Clearing a due date clears the due time with it (the API's rule). Setting a time on the date ALREADY stored is made
 * conditional inside the write (`dueDate: { $exists: true, $ne: null }` added to the filter), so a concurrent removal of
 * the date cannot slip between a check and the write: the write simply matches nothing.
 *
 * NOT protected, by design: the native driver (`Task.collection.*`, `Task.db`), `save({ middleware: false })` (which skips
 * every hook), a hand-written shell or script write, and data stored before this model existed. Mongoose cannot see
 * those; a MongoDB collection validator would be the only guard and needs an ops migration, so it is not part of this
 * model.
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

const has = (object: object | undefined, key: string): boolean => object !== undefined && Object.prototype.hasOwnProperty.call(object, key);
const isMissing = (value: unknown): boolean => value === undefined || value === null;
const touchesDeadline = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && Object.keys(value).some((key) => /^due(Date|Time)(\.|$)/.test(key));
const STORED_DUE_DATE = { dueDate: { $exists: true, $ne: null } };

const needsDueDateError = (value: unknown): MongooseError.ValidationError => {
  const error = new MongooseError.ValidationError();
  error.addError(
    'dueTime',
    new MongooseError.ValidatorError({ message: DUE_TIME_NEEDS_DUE_DATE_MESSAGE, path: 'dueTime', value, type: 'user defined' }),
  );
  return error;
};

/**
 * A date that can stand as a due date: a valid Date, or a string/number that parses to one. Raw writes (a replacement,
 * a bulk insert, a lean insertMany) may not have been cast yet, or never will be, so this does not demand a Date
 * instance, but 'banana' or an invalid Date is not a date.
 */
const isUsableDate = (value: unknown): boolean => {
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === 'string' || typeof value === 'number') return !Number.isNaN(new Date(value).getTime());
  return false;
};

/**
 * Rejects a whole document (a replacement, a bulk insert, an insertMany entry) that has a time and no usable date. This
 * is the check that holds when Mongoose's own validation is switched off (`bulkWrite(..., { skipValidation: true })`,
 * `insertMany(..., { lean: true })`), so it does not depend on schema validators.
 */
const assertDocument = (doc: unknown): void => {
  const fields = (doc ?? {}) as { dueDate?: unknown; dueTime?: unknown };
  if (!isMissing(fields.dueTime) && !isUsableDate(fields.dueDate)) throw needsDueDateError(fields.dueTime);
};

/**
 * Applies the invariant to one update document, IN PLACE, and says whether the write must require a stored dueDate.
 * Throws on a contradictory update (sets a time while removing the date) and on shapes it cannot reason about.
 */
export function guardDeadlineUpdate(update: unknown, options: { upsert?: boolean } = {}): { requireStoredDueDate: boolean } {
  if (Array.isArray(update)) {
    throw new Error('Aggregation-pipeline updates are not supported on tasks: the dueDate/dueTime rule cannot be enforced on them');
  }
  const u = (update ?? {}) as Record<string, Record<string, unknown> | undefined> & Record<string, unknown>;

  for (const [operator, body] of Object.entries(u)) {
    if (!operator.startsWith('$') || operator === '$set' || operator === '$unset') continue;
    const renamesDeadline = operator === '$rename' && Object.values(body ?? {}).some((target) => typeof target === 'string' && touchesDeadline({ [target]: 1 }));
    if (touchesDeadline(body) || renamesDeadline) {
      throw new Error(`${operator} on dueDate/dueTime is not supported on tasks: the dueDate/dueTime rule cannot be enforced on it`);
    }
  }

  const topLevel = Object.fromEntries(Object.entries(u).filter(([key]) => !key.startsWith('$')));
  const set = { ...topLevel, ...(u.$set ?? {}) };
  const unset = u.$unset ?? {};

  const setsTime = has(set, 'dueTime') && !isMissing(set.dueTime);
  const setsDate = has(set, 'dueDate') && !isMissing(set.dueDate);
  const removesDate = has(unset, 'dueDate') || (has(set, 'dueDate') && isMissing(set.dueDate));

  if (setsTime && removesDate) throw needsDueDateError(set.dueTime);

  if (removesDate) {
    // Clearing the date clears the time with it. A `$set: { dueTime: null }` in the same update would conflict with
    // the `$unset`, so it is folded into it.
    delete u.dueTime;
    if (u.$set) delete u.$set.dueTime;
    u.$unset = { ...unset, dueTime: 1 };
    return { requireStoredDueDate: false };
  }

  if (setsTime && !setsDate) {
    // The time goes onto the date already stored, which an upsert (inserting a new document) does not have.
    if (options.upsert) throw needsDueDateError(set.dueTime);
    return { requireStoredDueDate: true };
  }

  return { requireStoredDueDate: false };
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
      validate: { validator: dueTimeNeedsDueDate, message: DUE_TIME_NEEDS_DUE_DATE_MESSAGE },
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

// Documents: runs on every save/create/insertMany, as a validate hook AND a save hook, so it also holds when validation is
// switched off with `validateBeforeSave: false`. Clearing the date of a loaded task clears the time with it, as the API
// does (Mongoose's field validator alone would reject that save instead, and is skipped for an unmodified dueTime when
// validation is limited to modified paths); any other time-without-date is rejected, never silently turned into
// something that looks valid.
function enforceOnDocument(this: { dueTime?: unknown; dueDate?: unknown; isNew: boolean; isModified(path: string): boolean; set(path: string, value: unknown): void }) {
  if (isMissing(this.dueTime) || isUsableDate(this.dueDate)) return;
  if (!this.isNew && this.isModified('dueDate') && !this.isModified('dueTime')) {
    this.set('dueTime', undefined);
    return;
  }
  // Thrown, not `invalidate()`d: Mongoose drops invalidations of unmodified paths when validation is limited to modified ones.
  throw needsDueDateError(this.dueTime);
}
taskSchema.pre('validate', enforceOnDocument);
taskSchema.pre('save', enforceOnDocument);

taskSchema.pre(['findOneAndUpdate', 'updateOne', 'updateMany'], function (this: Query<unknown, unknown>) {
  const update = this.getUpdate();
  if (!update) return;
  const { requireStoredDueDate } = guardDeadlineUpdate(update, this.getOptions());
  if (requireStoredDueDate) this.and([STORED_DUE_DATE]);
});

taskSchema.pre(['replaceOne', 'findOneAndReplace'], function (this: Query<unknown, unknown>) {
  assertDocument(this.getUpdate());
});

type BulkOperation = Record<string, { filter?: object; update?: unknown; upsert?: boolean; replacement?: unknown; document?: unknown } | undefined>;

taskSchema.pre('bulkWrite', function (operations: unknown) {
  for (const operation of (Array.isArray(operations) ? operations : []) as BulkOperation[]) {
    for (const kind of ['updateOne', 'updateMany'] as const) {
      const op = operation[kind];
      if (!op) continue;
      const { requireStoredDueDate } = guardDeadlineUpdate(op.update, { upsert: op.upsert });
      if (requireStoredDueDate) op.filter = { $and: [op.filter ?? {}, STORED_DUE_DATE] };
    }
    if (operation.replaceOne) assertDocument(operation.replaceOne.replacement);
    // Mongoose validates insertOne documents by default, but not with `skipValidation: true` (and Model.bulkSave always
    // passes that), so the document itself is checked here.
    if (operation.insertOne) assertDocument(operation.insertOne.document);
  }
});

// insertMany with `lean: true` never builds, casts or validates the documents (and its middleware is not told the options),
// so every entry, document or plain object, is checked before anything is sent.
taskSchema.pre('insertMany', function (documents: unknown) {
  for (const document of Array.isArray(documents) ? documents : [documents]) assertDocument(document);
});

const Task = model('Task', taskSchema);

export default Task;
