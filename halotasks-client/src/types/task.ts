import type { GrowthResult } from '../growth/treeTypes';

export type Priority = 'low' | 'medium' | 'high';

export type Task = {
  _id: string;
  userId: string;
  title: string;
  description: string;
  completed: boolean;
  priority: Priority;
  tags: string[];
  /** The due DAY. ISO date string; its UTC date part is the calendar day the user picked (see utils/deadline.ts). */
  dueDate?: string;
  /** Optional wall-clock time of day ("HH:mm") on the due day. Only ever present together with `dueDate`. */
  dueTime?: string;
  /** Optional absolute instant (ISO 8601) the user intends to begin. */
  startTime?: string;
  estimatedMinutes: number;
  reminderSent: boolean;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  pendingSync?: boolean;
  /**
   * Client-only. The local id the task was created under while offline. It is kept after the server assigns the real
   * `_id` so the task keeps ONE reminder identity (see reminders/identity.ts). Never sent to the server.
   */
  clientKey?: string;
};

export type TaskListResponse = {
  tasks: Task[];
  page?: number;
  limit?: number;
  total?: number;
  hasMore?: boolean;
};

export type TaskCreatePayload = {
  title: string;
  description?: string;
  priority: Priority;
  tags?: string[];
  dueDate?: string;
  dueTime?: string;
  startTime?: string;
  estimatedMinutes?: number;
};

/** `null` clears an optional field on the server (an absent key leaves it unchanged). */
export type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate' | 'dueTime' | 'startTime'> & {
  completed?: boolean;
  dueDate?: string | null;
  dueTime?: string | null;
  startTime?: string | null;
};

export type TaskResponse = {
  task: Task;
  /** Present when the server processed a completion for this request (Issue #24). */
  growth?: GrowthResult;
};
