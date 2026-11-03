import { Priority, Subtask } from '../../types/task';

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
  /** Present when the form edits the description; absent means this edit session does not touch it. */
  description?: string;
  /** Present when the form edits the checklist. The opening copy lives in the hook (not here), so editing cannot alter it. */
  subtasks?: Subtask[];
  /** Why the last save was refused (shown in the form, which keeps what the user typed); cleared by the next edit. */
  saveError?: string | null;
};
