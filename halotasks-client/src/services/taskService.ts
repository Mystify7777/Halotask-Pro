import { apiClient } from './api';
import { TaskCreatePayload, TaskListResponse, TaskResponse } from '../types/task';

export const taskService = {
  getTasks: async () => {
    const response = await apiClient.get<TaskListResponse>('/api/tasks');
    return response.data;
  },
  createTask: async (payload: TaskCreatePayload) => {
    const response = await apiClient.post<TaskResponse>('/api/tasks', payload);
    return response.data;
  },
  updateTask: async (taskId: string, payload: Partial<TaskCreatePayload> & { completed?: boolean }) => {
    const response = await apiClient.put<TaskResponse>(`/api/tasks/${taskId}`, payload);
    return response.data;
  },
  deleteTask: async (taskId: string) => {
    await apiClient.delete(`/api/tasks/${taskId}`);
  },
};