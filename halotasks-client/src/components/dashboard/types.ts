import { Priority } from '../../types/task';

export type TaskEditState = {
  title: string;
  priority: Priority;
  tags: string[];
  tagInput: string;
  dueDate: string;
  estimatedMinutes: string;
};
