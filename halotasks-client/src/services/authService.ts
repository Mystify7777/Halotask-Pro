import { apiClient } from './api';
import { AuthResponse, LoginPayload, RegisterPayload } from '../types/auth';

export const authService = {
  register: async (payload: RegisterPayload) => {
    const response = await apiClient.post<AuthResponse>('/api/auth/register', payload);
    return response.data;
  },
  login: async (payload: LoginPayload) => {
    const response = await apiClient.post<AuthResponse>('/api/auth/login', payload);
    return response.data;
  },
};