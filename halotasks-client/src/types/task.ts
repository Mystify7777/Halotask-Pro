import type { GrowthResult } from '../growth/treeTypes';

export type Priority = 'low' | 'medium' | 'high';

/**
 * One checklist item on a task (Issue #15). The `id` is created by the client once, when the subtask is created, and
 * never changes (also across the offline local-id remap), so a later per-item merge stays possible. A subtask has only
 * a title and a state: no priority, dates, tags or reminders, and it never completes (or reopens) its parent.
 */
export type Subtask = {
  id: string;
  title: string;
  completed: boolean;
};

export type Task = {
  _id: string;
  userId: string;
  title: string;
  description: string;
  completed: boolean;
  priority: Priority;
  tags: string[];
  /** Absent on tasks cached before the field existed: read it through utils/subtasks.ts, which treats that as `[]`. */
  subtasks?: Subtask[];
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
  /**
   * The completion this task holds while `completed` is true (and the one it held last while it is false). Written by the
   * server in the same write as `completed` (Issue #47); the client sets it when the user completes the task, so a later
   * un-complete can name exactly the completion it ends. Absent or null for a task completed before completion records existed.
   */
  completionId?: string | null;
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
  /** The WHOLE list (last writer wins). Omitting it leaves the stored list unchanged; `[]` clears it. */
  subtasks?: Subtask[];
  dueDate?: string;
  dueTime?: string;
  startTime?: string;
  estimatedMinutes?: number;
};

/**
 * The completion event a task write carries (Issue #47). Its kind follows `completed`, exactly as the server reads it:
 * `completed: true` carries a completion, `completed: false` a revocation. Same shape as the server contract
 * (halotasks-server/src/utils/completionValidators.ts), not a second protocol.
 */
export type CompleteEventPayload = { completionId: string; completedAt: string; utcOffsetMinutes: number };
export type RevokeEventPayload = { completionId?: string; revokedAt: string };
export type TaskCompletionEventPayload = CompleteEventPayload | RevokeEventPayload;

/** `null` clears an optional field on the server (an absent key leaves it unchanged). */
export type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate' | 'dueTime' | 'startTime'> & {
  completed?: boolean;
  /** Present only with `completed`; see TaskCompletionEventPayload. */
  completionEvent?: TaskCompletionEventPayload;
  dueDate?: string | null;
  dueTime?: string | null;
  startTime?: string | null;
};

export type TaskResponse = {
  task: Task;
  /** Present when the server processed a completion for this request (Issue #24). */
  growth?: GrowthResult;
};
