import { apiClient } from './api';
import { TaskCreatePayload, TaskListResponse, TaskResponse } from '../types/task';

type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate'> & {
  completed?: boolean;
  dueDate?: string | null;
};

export const taskService = {
  getTasks: async () => {
    const response = await apiClient.get<TaskListResponse>('/api/tasks');
    return response.data;
  },
  createTask: async (payload: TaskCreatePayload) => {
    const response = await apiClient.post<TaskResponse>('/api/tasks', payload);
    return response.data;
  },
  updateTask: async (taskId: string, payload: TaskUpdatePayload) => {
    const response = await apiClient.put<TaskResponse>(`/api/tasks/${taskId}`, payload);
    return response.data;
  },
  deleteTask: async (taskId: string) => {
    await apiClient.delete(`/api/tasks/${taskId}`);
  },
};