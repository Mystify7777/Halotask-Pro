import { apiClient, type BoundSession, type SessionRequestConfig } from './api';
import { Task, TaskCreatePayload, TaskListResponse, TaskResponse } from '../types/task';

type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate'> & {
  completed?: boolean;
  dueDate?: string | null;
};

// Matches the server's bounded max page size (halotasks-server/src/utils/pagination.ts).
// Requesting this explicitly on every call means the server's own default
// (also 200) is never relied on implicitly — if either side's constant ever
// changes, this still asks for a full page rather than silently drifting.
const TASKS_PAGE_SIZE = 200;
// Sanity ceiling so a backend bug that never reports hasMore: false can't
// loop forever — 500 pages at 200/page is 100,000 tasks, far beyond any
// realistic use of this app. Hitting it is treated as an error, never as a
// "successful" partial result: returning a truncated list with no signal
// would be silent data loss, which is worse than failing loudly.
const MAX_TASK_PAGES = 500;

export const taskService = {
  getTasks: async () => {
    const allTasks: Task[] = [];
    let page = 1;
    let hasMore = true;
    let last: TaskListResponse = { tasks: [] };

    // The backend caps a single page at TASKS_PAGE_SIZE tasks — loop so a
    // user with more tasks than that still gets their full list in one
    // logical call, rather than silently seeing only the first page.
    while (hasMore && page <= MAX_TASK_PAGES) {
      const response = await apiClient.get<TaskListResponse>('/api/tasks', {
        params: { page, limit: TASKS_PAGE_SIZE },
      });
      last = response.data;
      allTasks.push(...last.tasks);

      // A server that hasn't deployed pagination yet (or any response
      // without the field) won't report hasMore — treat that as "done"
      // rather than looping forever.
      hasMore = last.hasMore === true;
      page += 1;
    }

    if (hasMore) {
      throw new Error('Task list exceeded the maximum supported page count');
    }

    // The client-facing result represents one complete, aggregated list —
    // not any single server page — so the pagination metadata is set to
    // describe that: everything on "page 1", nothing more to fetch.
    return { ...last, tasks: allTasks, page: 1, limit: allTasks.length, hasMore: false };
  },
  // `options.session` binds the request to the account + token a caller captured earlier (the offline
  // queue replays one account's work later): the request is sent with that token, or not sent at all if
  // the signed-in session is no longer it. Omit it for ordinary "as the current user" requests.
  createTask: async (payload: TaskCreatePayload, options?: { session?: BoundSession }) => {
    const config: SessionRequestConfig = { session: options?.session };
    const response = await apiClient.post<TaskResponse>('/api/tasks', payload, config);
    return response.data;
  },
  updateTask: async (taskId: string, payload: TaskUpdatePayload, options?: { session?: BoundSession }) => {
    const config: SessionRequestConfig = { session: options?.session };
    const response = await apiClient.put<TaskResponse>(`/api/tasks/${taskId}`, payload, config);
    return response.data;
  },
  deleteTask: async (taskId: string, options?: { session?: BoundSession }) => {
    const config: SessionRequestConfig = { session: options?.session };
    await apiClient.delete(`/api/tasks/${taskId}`, config);
  },
};