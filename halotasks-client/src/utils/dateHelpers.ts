import { getDueState } from './deadline';

export const formatDateForInput = (value?: string) => {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().split('T')[0];
};

/**
 * CSS class for a due-date badge. Uses the shared deadline model (utils/deadline.ts): the due DAY is read as the
 * calendar day that was picked, and a task with a due time is overdue from that exact moment.
 */
export const getDateBadgeClass = (value?: string, dueTime?: string, now: Date = new Date()) => {
  const state = getDueState({ dueDate: value, dueTime }, now);
  if (state === 'overdue') return 'date-overdue';
  if (state === 'today') return 'date-today';
  return 'date-muted';
};
