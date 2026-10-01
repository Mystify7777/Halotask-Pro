import { apiClient } from './api';
import type { Priority } from '../types/task';

// Matches halotasks-server/src/utils/aiTaskParser.ts (AI_PROMPT_MAX_LENGTH).
export const AI_PROMPT_MAX_LENGTH = 2000;

export type ParsedAiTask = {
  title?: string;
  priority?: Priority;
  dueDate?: string;
  estimatedMinutes?: number;
  tags?: string[];
  description?: string;
};

export const aiService = {
  /**
   * Asks the backend to turn free text into task drafts. The backend owns the AI provider and its
   * credentials; the browser only sends the user's text, authenticated like every other API call.
   */
  parseTasks: async (prompt: string): Promise<ParsedAiTask[]> => {
    const response = await apiClient.post<{ tasks: ParsedAiTask[] }>('/api/ai/parse-tasks', { prompt });
    return Array.isArray(response.data?.tasks) ? response.data.tasks : [];
  },
};
