import { apiClient, type BoundSession, type SessionRequestConfig } from './api';

// POST /api/completion-events (Issue #47): delivers ONE completion event whose task cannot be written, because it was deleted
// before the event reached the server or never existed there (created and deleted offline). A task that still exists takes
// its event on the task write instead (taskService.updateTask with `completionEvent`), where it is arbitrated with the task.
// Both paths end in the same server service, so one completionId is one record however it arrives.

export type StandaloneCompleteBody = {
  type: 'complete';
  completionId: string;
  taskId: string;
  title: string;
  estimatedMinutes: number;
  completedAt: string;
  utcOffsetMinutes: number;
};

export type StandaloneRevokeBody = {
  type: 'revoke';
  completionId: string;
  taskId: string;
  revokedAt: string;
};

export type StandaloneEventBody = StandaloneCompleteBody | StandaloneRevokeBody;

export type StandaloneEventResponse = {
  completion: { outcome: string; completionId?: string; status?: string };
};

export const completionService = {
  postEvent: async (body: StandaloneEventBody, options?: { session?: BoundSession }): Promise<StandaloneEventResponse> => {
    const config: SessionRequestConfig = { session: options?.session };
    const response = await apiClient.post<StandaloneEventResponse>('/api/completion-events', body, config);
    return response.data;
  },
};
