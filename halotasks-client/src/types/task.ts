export type Priority = 'low' | 'medium' | 'high';

export type Task = {
  _id: string;
  userId: string;
  title: string;
  description: string;
  completed: boolean;
  priority: Priority;
  tags: string[];
  dueDate?: string;
  estimatedMinutes: number;
  reminderSent: boolean;
  createdAt: string;
  updatedAt: string;
  pendingSync?: boolean;
};

export type TaskListResponse = {
  tasks: Task[];
};

export type TaskCreatePayload = {
  title: string;
  description?: string;
  priority: Priority;
  tags?: string[];
  dueDate?: string;
  estimatedMinutes?: number;
};

export type TaskResponse = {
  task: Task;
};