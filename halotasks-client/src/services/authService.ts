import { apiClient } from './api';
import {
  AuthMessageResponse,
  AuthResponse,
  ForgotPasswordPayload,
  LoginPayload,
  RegisterPayload,
  ResetPasswordPayload,
} from '../types/auth';

export const authService = {
  register: async (payload: RegisterPayload) => {
    const response = await apiClient.post<AuthResponse>('/api/auth/register', payload);
    return response.data;
  },
  login: async (payload: LoginPayload) => {
    const response = await apiClient.post<AuthResponse>('/api/auth/login', payload);
    return response.data;
  },
  forgotPassword: async (payload: ForgotPasswordPayload) => {
    const response = await apiClient.post<AuthMessageResponse>('/api/auth/forgot-password', payload);
    return response.data;
  },
  resetPassword: async (payload: ResetPasswordPayload) => {
    const response = await apiClient.post<AuthMessageResponse>('/api/auth/reset-password', payload);
    return response.data;
  },
};