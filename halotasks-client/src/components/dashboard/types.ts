import { Priority } from '../../types/task';

export type TaskEditState = {
  title: string;
  priority: Priority;
  tags: string[];
  tagInput: string;
  dueDate: string;
  /** `HH:mm`, or '' for none. */
  dueTime: string;
  /** `datetime-local` value (local wall-clock), or '' for none. */
  startTime: string;
  estimatedMinutes: string;
};
