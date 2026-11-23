import type { Subtask } from './taskValidators';

// Field-level conflict detection for batched task updates (Issue #62A).
//
// A batch update may carry `base`: for each field it sets or clears, the value the CLIENT last knew the server to hold when
// the user began editing it (62 D1, D11). The server compares that expected value with what is stored NOW:
//
//   stored == base       nobody else changed the field: apply the edit
//   stored == requested  somebody already produced the wanted value: apply (a harmless no-op for that field, D5)
//   anything else        conflict: the WHOLE mutation writes nothing (D3)
//
// This is NOT a revision counter and NOT `syncedRevision` (a client-side snapshot ordering that never reaches the server). The
// unit is the value of each field, so two devices that edit DIFFERENT fields never conflict. Arrays (`tags`, `subtasks`) are
// one field each: the whole list is the expected value (D6). There is no merge; deletes have no precondition (D9).
//
// The check itself is a read followed by a write, so the write repeats it atomically: updateTaskService adds the OBSERVED
// stored values to the write's filter (`observedFilter`), and if another request changed one in between, the write matches
// nothing and the service evaluates again from a fresh read.

export const TASK_FIELD_CONFLICT = 'TASK_FIELD_CONFLICT';
export const INVALID_BASE = 'INVALID_BASE';

/** The fields a mutation can state an expected value for. `completed` is excluded: completions are their own mutation type. */
export const CHECKED_FIELDS = ['title', 'description', 'priority', 'tags', 'subtasks', 'dueDate', 'dueTime', 'startTime', 'estimatedMinutes', 'reminderSent'] as const;
export type CheckedField = (typeof CHECKED_FIELDS)[number];
export const isCheckedField = (key: string): key is CheckedField => (CHECKED_FIELDS as readonly string[]).includes(key);

/** A field value in its comparable form: `null` is "no value" (an optional field that is absent). */
export type FieldValue = string | number | boolean | Date | null | string[] | Subtask[];
export type BaseValues = Partial<Record<CheckedField, FieldValue>>;

/** One conflicted field, JSON-ready (dates as ISO strings, absent as null). */
export type FieldConflict = { field: CheckedField; base: unknown; requested: unknown; current: unknown };

/** What the schema stores for a field that was never set (Mongoose fills these on read, so a legacy document may lack them in the database). */
const DEFAULTS: Partial<Record<CheckedField, string | number | boolean>> = { description: '', priority: 'medium', estimatedMinutes: 0, reminderSent: false };
const DATE_FIELDS: readonly CheckedField[] = ['dueDate', 'startTime'];

const toSubtasks = (value: unknown): Subtask[] =>
  Array.from((value ?? []) as ArrayLike<Subtask>).map((entry) => ({ id: entry.id, title: entry.title, completed: entry.completed }));

/** The value a STORED task holds for a field, in comparable form. */
export const storedValue = (task: unknown, field: CheckedField): FieldValue => {
  const raw = (task as Record<string, unknown>)[field];
  if (field === 'tags') return Array.from((raw ?? []) as ArrayLike<string>);
  if (field === 'subtasks') return toSubtasks(raw);
  if (DATE_FIELDS.includes(field)) return raw == null ? null : raw instanceof Date ? raw : new Date(raw as string);
  if (raw === undefined || raw === null) return field in DEFAULTS ? (DEFAULTS[field] as FieldValue) : null;
  return raw as FieldValue;
};

/** The value a parsed request body (or parsed base) holds for a field; `undefined` when it says nothing about the field. */
export const bodyValue = (parsed: { clear: { dueDate: boolean; dueTime: boolean; startTime: boolean } } & Partial<Record<CheckedField, unknown>>, field: CheckedField): FieldValue | undefined => {
  if (field === 'dueDate' || field === 'dueTime' || field === 'startTime') {
    if (parsed.clear[field]) return null;
  }
  return parsed[field] as FieldValue | undefined;
};

const sameSubtasks = (a: Subtask[], b: Subtask[]) =>
  a.length === b.length && a.every((entry, i) => entry.id === b[i].id && entry.title === b[i].title && entry.completed === b[i].completed);

export const sameValue = (a: FieldValue, b: FieldValue): boolean => {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    if (a.length > 0 && typeof a[0] === 'object') return typeof b[0] === 'object' && sameSubtasks(a as Subtask[], b as Subtask[]);
    return (a as string[]).every((entry, i) => entry === b[i]);
  }
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  return a === b;
};

const serialise = (value: FieldValue | undefined): unknown => {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((entry) => (typeof entry === 'object' ? { ...entry } : entry));
  return value;
};

type Clause = Record<string, unknown>;

/** A filter clause that holds only while the stored field still equals `observed`. Written to match MongoDB's equality rules, see below. */
const equalityClause = (field: CheckedField, observed: FieldValue): Clause => {
  if (field === 'tags' || field === 'subtasks') {
    const list = observed as unknown[];
    // an empty list also matches a field the database does not have (a legacy document reads as [] through the schema default)
    if (list.length === 0) return { $or: [{ [field]: { $size: 0 } }, { [field]: null }] };
    const clause: Clause = { [field]: { $size: list.length } };
    list.forEach((entry, index) => {
      // positional paths, never a whole-subdocument match: MongoDB's equality on a subdocument also compares KEY ORDER
      if (field === 'tags') clause[`tags.${index}`] = entry;
      else for (const key of ['id', 'title', 'completed'] as const) clause[`subtasks.${index}.${key}`] = (entry as Subtask)[key];
    });
    return clause;
  }
  if (observed === null) return { [field]: null }; // null matches a missing field
  if (field in DEFAULTS && observed === DEFAULTS[field]) return { $or: [{ [field]: observed }, { [field]: null }] };
  return { [field]: observed };
};

export type Verdict = { conflicts: FieldConflict[]; clauses: Clause[] };

/**
 * Compares the stored task with the expected values of a mutation. `clauses` (meaningful when there is no conflict) pin every
 * checked field to the value just observed, for the conditional write.
 */
export const evaluateBase = (stored: unknown, base: BaseValues, requested: Parameters<typeof bodyValue>[0]): Verdict => {
  const conflicts: FieldConflict[] = [];
  const clauses: Clause[] = [];
  for (const field of CHECKED_FIELDS) {
    const expected = base[field];
    if (expected === undefined) continue;
    const current = storedValue(stored, field);
    const wanted = bodyValue(requested, field) ?? null;
    if (!sameValue(current, expected) && !sameValue(current, wanted)) {
      conflicts.push({ field, base: serialise(expected), requested: serialise(wanted), current: serialise(current) });
    }
    clauses.push(equalityClause(field, current));
  }
  return { conflicts, clauses };
};
