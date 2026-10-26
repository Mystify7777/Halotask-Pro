import { apiClient } from './api';
import type { UserPreferences } from '../types/auth';

export const userService = {
  /** The saved preferences of the signed-in account (`timeZone: null` when none is saved). */
  getPreferences: async () => {
    const response = await apiClient.get<UserPreferences>('/api/user/preferences');
    return response.data;
  },
  /** Saves (or, with null, clears) the time zone. Resolves with what the server stored. */
  updatePreferences: async (payload: UserPreferences) => {
    const response = await apiClient.put<UserPreferences>('/api/user/preferences', payload);
    return response.data;
  },
};
