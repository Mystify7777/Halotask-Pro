import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiClient } from './api';
import { AI_PROMPT_MAX_LENGTH, aiService } from './aiService';

vi.mock('./api', () => ({
  apiClient: { post: vi.fn() },
}));

afterEach(() => vi.mocked(apiClient.post).mockReset());

describe('aiService.parseTasks', () => {
  it('posts only the prompt to the authenticated backend endpoint', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: { tasks: [{ title: 'Buy milk' }] } });

    const tasks = await aiService.parseTasks('buy milk');

    expect(apiClient.post).toHaveBeenCalledTimes(1);
    expect(apiClient.post).toHaveBeenCalledWith('/api/ai/parse-tasks', { prompt: 'buy milk' });
    expect(tasks).toEqual([{ title: 'Buy milk' }]);
  });

  it('treats a response without a tasks array as no tasks', async () => {
    vi.mocked(apiClient.post).mockResolvedValueOnce({ data: {} });
    expect(await aiService.parseTasks('x')).toEqual([]);
  });

  it('propagates failures so the caller can show the server message', async () => {
    vi.mocked(apiClient.post).mockRejectedValueOnce(new Error('boom'));
    await expect(aiService.parseTasks('x')).rejects.toThrow('boom');
  });

  it('exposes the same prompt limit the server enforces', () => {
    expect(AI_PROMPT_MAX_LENGTH).toBe(2000);
  });
});
