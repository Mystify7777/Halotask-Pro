import axios, { AxiosError } from 'axios';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAiTaskCreation } from './useAiTaskCreation';

vi.mock('../services/aiService', () => ({
  aiService: { parseTasks: vi.fn() },
}));
// The real api module pulls in the auth store and IndexedDB; only its error helper matters here, so
// it is reproduced faithfully (same logic as services/api.ts getApiErrorMessage).
vi.mock('../services/api', () => ({
  getApiErrorMessage: (error: unknown, fallback = 'Something went wrong') =>
    axios.isAxiosError(error) ? (error.response?.data?.message ?? fallback) : fallback,
}));
vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn() },
}));

import { aiService } from '../services/aiService';

const setup = () =>
  renderHook(() =>
    useAiTaskCreation({
      persistTasks: vi.fn(),
      isOnline: true,
      setStatusInfo: vi.fn(),
      setStatusError: vi.fn(),
    }),
  );

const parse = async (hook: ReturnType<typeof setup>, text: string) => {
  act(() => hook.result.current.openAi());
  act(() => hook.result.current.setAiPrompt(text));
  await act(async () => {
    await hook.result.current.parsePrompt();
  });
};

afterEach(() => {
  vi.mocked(aiService.parseTasks).mockReset();
  vi.unstubAllGlobals();
});

describe('useAiTaskCreation (backend-backed)', () => {
  it('turns backend drafts into the same preview drafts as before', async () => {
    vi.mocked(aiService.parseTasks).mockResolvedValueOnce([
      { title: ' Book dentist ', priority: 'high', dueDate: '2026-10-06', estimatedMinutes: 30, tags: ['Health', 'health'], description: 'Call' },
      { priority: 'bogus' as never, tags: undefined },
    ]);
    const hook = setup();

    await parse(hook, '  Book dentist next Tuesday  ');

    expect(aiService.parseTasks).toHaveBeenCalledWith('Book dentist next Tuesday');
    expect(hook.result.current.aiPhase).toBe('preview');
    const [a, b] = hook.result.current.aiDrafts;
    expect(a).toMatchObject({ title: 'Book dentist', priority: 'high', dueDate: '2026-10-06', estimatedMinutes: 30, description: 'Call' });
    expect(a.tags).toEqual(['health']);
    expect(a.id).toMatch(/^ai-\d+-0$/);
    expect(b).toMatchObject({ title: 'Untitled task', priority: 'medium', description: '' });
    expect(b.tags).toEqual(['personal']);
  });

  it('shows the "no tasks found" guidance when the backend returns an empty list', async () => {
    vi.mocked(aiService.parseTasks).mockResolvedValueOnce([]);
    const hook = setup();
    await parse(hook, 'hello');
    expect(hook.result.current.aiPhase).toBe('input');
    expect(hook.result.current.aiError).toMatch(/Couldn't find any tasks/);
  });

  it('shows the backend error message and returns to input on an API error', async () => {
    const error = new AxiosError('Request failed', 'ERR_BAD_RESPONSE', undefined, undefined, {
      status: 502,
      data: { message: 'The AI service is currently unavailable. Please try again later.' },
    } as never);
    vi.mocked(aiService.parseTasks).mockRejectedValueOnce(error);
    const hook = setup();

    await parse(hook, 'buy milk');

    expect(axios.isAxiosError(error)).toBe(true);
    expect(hook.result.current.aiPhase).toBe('input');
    expect(hook.result.current.aiError).toBe('The AI service is currently unavailable. Please try again later.');
  });

  it('falls back to a generic message when there is no response (network down)', async () => {
    vi.mocked(aiService.parseTasks).mockRejectedValueOnce(new Error('Network Error'));
    const hook = setup();
    await parse(hook, 'buy milk');
    expect(hook.result.current.aiError).toBe('Failed to parse tasks. Please try again.');
  });

  it('does nothing for a blank prompt and never calls any network function', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const hook = setup();
    await parse(hook, '   ');
    expect(aiService.parseTasks).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('never calls fetch directly (no browser-to-provider request)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    vi.mocked(aiService.parseTasks).mockResolvedValueOnce([{ title: 'x' }]);
    const hook = setup();
    await parse(hook, 'x');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
