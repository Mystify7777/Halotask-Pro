import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api';
import { taskService } from './taskService';
import type { Task, TaskListResponse } from '../types/task';

vi.mock('./api', () => ({
  apiClient: { get: vi.fn() },
}));

function makeTask(id: string): Task {
  return {
    _id: id,
    userId: 'user-1',
    title: `Task ${id}`,
    description: '',
    completed: false,
    priority: 'medium',
    tags: [],
    estimatedMinutes: 0,
    reminderSent: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('taskService.getTasks', () => {
  afterEach(() => {
    vi.mocked(apiClient.get).mockReset();
  });

  it('returns every task in a single call when the server reports a single page', async () => {
    const response: TaskListResponse = {
      tasks: [makeTask('a'), makeTask('b')],
      page: 1,
      limit: 200,
      total: 2,
      hasMore: false,
    };
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: response });

    const result = await taskService.getTasks();

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(2);
  });

  it('transparently fetches every page when the server reports more than one page', async () => {
    const pageOne: TaskListResponse = {
      tasks: [makeTask('1'), makeTask('2')],
      page: 1,
      limit: 2,
      total: 5,
      hasMore: true,
    };
    const pageTwo: TaskListResponse = {
      tasks: [makeTask('3'), makeTask('4')],
      page: 2,
      limit: 2,
      total: 5,
      hasMore: true,
    };
    const pageThree: TaskListResponse = {
      tasks: [makeTask('5')],
      page: 3,
      limit: 2,
      total: 5,
      hasMore: false,
    };

    vi.mocked(apiClient.get)
      .mockResolvedValueOnce({ data: pageOne })
      .mockResolvedValueOnce({ data: pageTwo })
      .mockResolvedValueOnce({ data: pageThree });

    const result = await taskService.getTasks();

    expect(apiClient.get).toHaveBeenCalledTimes(3);
    expect(result.tasks).toHaveLength(5);
    expect(result.tasks.map((t) => t._id)).toEqual(['1', '2', '3', '4', '5']);
  });

  it('stops after one call when the response omits hasMore (older/unpaginated server)', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({ data: { tasks: [makeTask('a')] } });

    const result = await taskService.getTasks();

    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(result.tasks).toHaveLength(1);
  });

  it('requests each page with the expected page/limit params', async () => {
    vi.mocked(apiClient.get).mockResolvedValueOnce({
      data: { tasks: [], page: 1, limit: 200, total: 0, hasMore: false },
    });

    await taskService.getTasks();

    expect(apiClient.get).toHaveBeenCalledWith('/api/tasks', { params: { page: 1, limit: 200 } });
  });

  it('reports the aggregated list as complete (hasMore: false) once every page is fetched', async () => {
    vi.mocked(apiClient.get)
      .mockResolvedValueOnce({
        data: { tasks: [makeTask('1')], page: 1, limit: 1, total: 2, hasMore: true },
      })
      .mockResolvedValueOnce({
        data: { tasks: [makeTask('2')], page: 2, limit: 1, total: 2, hasMore: false },
      });

    const result = await taskService.getTasks();

    expect(result.hasMore).toBe(false);
    expect(result.tasks).toHaveLength(2);
  });

  it('throws instead of returning a silently truncated list when the page ceiling is hit', async () => {
    // A backend that never stops reporting hasMore: true — the safety
    // ceiling must surface as an error, not as an apparently-successful
    // partial result.
    vi.mocked(apiClient.get).mockResolvedValue({
      data: { tasks: [makeTask('x')], page: 1, limit: 1, total: 999_999, hasMore: true },
    });

    await expect(taskService.getTasks()).rejects.toThrow(/maximum supported page count/);
  });
});
