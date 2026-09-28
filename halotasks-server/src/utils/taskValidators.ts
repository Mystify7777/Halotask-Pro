export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 2000;
export const TAG_MAX_LENGTH = 50;
export const TAGS_MAX_COUNT = 20;
export const ESTIMATED_MINUTES_MAX = 100_000;

export const TASK_PRIORITIES = ['low', 'medium', 'high'] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export function isValidPriority(value: unknown): value is TaskPriority {
  return typeof value === 'string' && (TASK_PRIORITIES as readonly string[]).includes(value);
}

export function isNonEmptyTitle(title: unknown): title is string {
  return typeof title === 'string' && title.trim().length > 0;
}

/**
 * Parses a due-date input and reports whether it's a genuinely valid date,
 * rather than silently persisting an Invalid Date. Returns `undefined` for
 * "not provided" (distinct from "provided but invalid").
 */
export function parseDueDate(raw: unknown): { ok: true; value: Date | undefined } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') {
    return { ok: true, value: undefined };
  }

  const date = new Date(String(raw));
  if (Number.isNaN(date.getTime())) {
    return { ok: false };
  }

  return { ok: true, value: date };
}

export function isValidEstimatedMinutes(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= ESTIMATED_MINUTES_MAX;
}
