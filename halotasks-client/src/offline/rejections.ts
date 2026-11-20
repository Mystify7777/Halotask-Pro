import type { RejectedMutation } from './queueProcessor';

/**
 * The one sentence the person reads when the server refused changes that had already been shown (Issue #57). It says the
 * change was NOT saved (it is no longer pending), and that what is shown now is what the server has. Pure.
 */
const WHAT: Record<RejectedMutation['type'], string> = {
  create: 'new task',
  update: 'edit to',
  delete: 'deletion of',
  completion: 'completion change for',
};

const describeOne = (item: RejectedMutation, fallbackTitle: string | null): string => {
  const title = item.title ?? fallbackTitle;
  const subject = item.type === 'create' ? (title ? `new task “${title}”` : 'new task') : `${WHAT[item.type]} ${title ? `“${title}”` : 'a task'}`;
  return item.status ? `${subject} (error ${item.status})` : subject;
};

export const describeRejections = (
  rejected: RejectedMutation[],
  titleOf: (taskId: string) => string | null = () => null,
): string | null => {
  if (rejected.length === 0) return null;
  const parts = rejected.slice(0, 3).map((item) => describeOne(item, item.taskId ? titleOf(item.taskId) : null));
  const more = rejected.length > 3 ? ` and ${rejected.length - 3} more` : '';
  return `Not saved: the server rejected the ${parts.join(', the ')}${more}. Showing what the server has.`;
};
