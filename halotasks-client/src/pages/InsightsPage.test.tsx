import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays } from '../insights/trend';
import type { TrendHistory } from '../insights/trendHistory';
import type { Task } from '../types/task';

const loadTrendHistory = vi.fn();
const invalidateTrendHistory = vi.fn();
const getTasks = vi.fn();
const updateTask = vi.fn();
const getWeekHistory = vi.fn();
const getCachedTasks = vi.fn();

vi.mock('../insights/trendHistory', () => ({
  loadTrendHistory: (...a: unknown[]) => loadTrendHistory(...a),
  invalidateTrendHistory: (...a: unknown[]) => invalidateTrendHistory(...a),
}));
vi.mock('../services/taskService', () => ({
  taskService: { getTasks: (...a: unknown[]) => getTasks(...a), updateTask: (...a: unknown[]) => updateTask(...a) },
}));
vi.mock('../offline/history', () => ({ getWeekHistory: (...a: unknown[]) => getWeekHistory(...a) }));
vi.mock('../offline/cache', () => ({ getCachedTasks: (...a: unknown[]) => getCachedTasks(...a) }));
vi.mock('../growth/treeStorage', () => ({
  initTreeStorage: vi.fn().mockResolvedValue({ streakDays: 3, lastActiveDate: null, xp: 10 }),
  applyServerGrowth: vi.fn(),
  TreeIdentityError: class extends Error {},
}));
vi.mock('../offline/completionEvents', () => ({
  makeCompletionTransition: (t: { completed: boolean }) => ({ completed: !t.completed, event: { id: 'e' }, localPatch: { completed: !t.completed } }),
}));
vi.mock('../components/dashboard/GrowthTree', () => ({ default: () => <div>tree</div> }));

import InsightsPage from './InsightsPage';

const today = new Date();
const TODAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
const points = (counts: number[]) =>
  counts.map((c, i) => ({ date: addDays(TODAY, -(counts.length - 1 - i)), completed: c, minutes: c * 10, known: true }));
const history = (counts: number[], over: Partial<TrendHistory> = {}): TrendHistory =>
  ({ coverage: 'full', points: points(counts), tasksByDate: {}, today: TODAY, fetchedAt: 0, ...over }) as TrendHistory;
const task = (over: Partial<Task> = {}): Task => ({
  _id: 't1', userId: 'u1', title: 'Task one', description: '', completed: false, priority: 'medium', tags: [], estimatedMinutes: 20,
  reminderSent: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ...over,
});
const doneToday = (id: string, title: string) => task({ _id: id, title, completed: true, completedAt: new Date().toISOString() });

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false })) as typeof window.matchMedia;
  [loadTrendHistory, invalidateTrendHistory, getTasks, updateTask, getWeekHistory, getCachedTasks].forEach((m) => m.mockReset());
  loadTrendHistory.mockResolvedValue(history(Array.from({ length: 90 }, () => 1)));
  getTasks.mockResolvedValue({ tasks: [] });
  getCachedTasks.mockResolvedValue([]);
});

const card = (label: RegExp) => screen.getByLabelText(label);

describe('InsightsPage: the trend comes first and drives "today"', () => {
  it('shows the trend section before Today at a glance, with the 30-day default', async () => {
    render(<InsightsPage />);
    expect(await screen.findByText('30 tasks in the last 30 days.')).toBeTruthy();
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(0, 2)).toEqual(['Activity', 'Today at a glance']);
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('switching the range re-reads nothing: it only re-slices the loaded series', async () => {
    render(<InsightsPage />);
    await screen.findByText('30 tasks in the last 30 days.');
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    expect(await screen.findByText('7 tasks in the last 7 days.')).toBeTruthy();
    expect(loadTrendHistory).toHaveBeenCalledTimes(1);
  });

  it('never uses the old 7-day card machinery, and never writes history', async () => {
    render(<InsightsPage />);
    await screen.findByText('30 tasks in the last 30 days.');
    expect(getWeekHistory).not.toHaveBeenCalled();
  });

  it('"Completed today" and "Work done today" are the series\' last point, the same as the chart\'s last bar', async () => {
    const counts = Array.from({ length: 90 }, () => 0);
    counts[89] = 4;
    loadTrendHistory.mockResolvedValue(history(counts));
    getTasks.mockResolvedValue({ tasks: [doneToday('a', 'A')] }); // the live list disagrees: 1 task
    render(<InsightsPage />);
    await waitFor(() => expect(card(/^Completed today: 4/)).toBeTruthy());
    expect(card(/^Work done today: 40m/)).toBeTruthy();
  });

  it('before the series arrives the cards use the live list, then switch to the series (no flicker to zero)', async () => {
    let release: (h: TrendHistory) => void = () => {};
    loadTrendHistory.mockReturnValue(new Promise((r) => { release = r; }));
    getTasks.mockResolvedValue({ tasks: [doneToday('a', 'A'), doneToday('b', 'B')] });
    render(<InsightsPage />);
    await waitFor(() => expect(card(/^Completed today: 2/)).toBeTruthy());
    await act(async () => release(history(Array.from({ length: 90 }, (_, i) => (i === 89 ? 5 : 0)))));
    expect(card(/^Completed today: 5/)).toBeTruthy();
  });
});

describe('InsightsPage: the completed-today list discloses what the list no longer holds (D5)', () => {
  it('history holds more than the live list: a footnote says how many are gone', async () => {
    const counts = Array.from({ length: 90 }, () => 0);
    counts[89] = 3;
    loadTrendHistory.mockResolvedValue(history(counts));
    getTasks.mockResolvedValue({ tasks: [doneToday('a', 'A')] });
    render(<InsightsPage />);
    const button = await screen.findByRole('button', { name: /^Completed today: 3/ });
    fireEvent.click(button);
    const dialog = screen.getByRole('dialog', { name: 'Completed today' });
    expect(within(dialog).getByText('A')).toBeTruthy();
    expect(within(dialog).getByText('2 completed tasks are no longer in your list.')).toBeTruthy();
  });

  it('count equal to the list: no footnote', async () => {
    const counts = Array.from({ length: 90 }, () => 0);
    counts[89] = 1;
    loadTrendHistory.mockResolvedValue(history(counts));
    getTasks.mockResolvedValue({ tasks: [doneToday('a', 'A')] });
    render(<InsightsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Completed today: 1/ }));
    expect(screen.queryByText(/no longer in your list/)).toBeNull();
  });

  it('history with nothing today but a live completion: the list is still reachable', async () => {
    const counts = Array.from({ length: 90 }, () => 0);
    loadTrendHistory.mockResolvedValue(history(counts));
    getTasks.mockResolvedValue({ tasks: [doneToday('a', 'A')] });
    render(<InsightsPage />);
    const button = await screen.findByRole('button', { name: /^Completed today: 0/ });
    fireEvent.click(button);
    expect(screen.getByText('A')).toBeTruthy();
  });
});

describe('InsightsPage: toggling a task from a list reads the history again', () => {
  it('a successful toggle invalidates the cache and reloads the series', async () => {
    getTasks.mockResolvedValue({ tasks: [task({ _id: 'x', title: 'Overdue one', dueDate: addDays(TODAY, -2) + 'T00:00:00.000Z' })] });
    updateTask.mockResolvedValue({ task: { completionId: 'c1', completedAt: new Date().toISOString() } });
    render(<InsightsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Overdue: 1/ }));
    loadTrendHistory.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Mark "Overdue one" complete' }));
    await waitFor(() => expect(loadTrendHistory).toHaveBeenCalledTimes(1));
    expect(invalidateTrendHistory).toHaveBeenCalled();
  });

  it('a failed toggle changes nothing about history', async () => {
    getTasks.mockResolvedValue({ tasks: [task({ _id: 'x', title: 'Overdue one', dueDate: addDays(TODAY, -2) + 'T00:00:00.000Z' })] });
    updateTask.mockRejectedValue(new Error('offline'));
    render(<InsightsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Overdue: 1/ }));
    loadTrendHistory.mockClear();
    invalidateTrendHistory.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Mark "Overdue one" complete' }));
    await waitFor(() => expect(updateTask).toHaveBeenCalled());
    await act(async () => {});
    expect(loadTrendHistory).not.toHaveBeenCalled();
    expect(invalidateTrendHistory).not.toHaveBeenCalled();
  });
});

describe('InsightsPage: other states', () => {
  it('a slow history does not hold back the task cards', async () => {
    loadTrendHistory.mockReturnValue(new Promise(() => {}));
    getTasks.mockResolvedValue({ tasks: [task({ dueDate: TODAY + 'T00:00:00.000Z' })] });
    render(<InsightsPage />);
    expect(await screen.findByLabelText(/^Due today: 1/)).toBeTruthy();
    expect(screen.getByText(/Loading your history/)).toBeTruthy();
  });

  it('the task list falls back to the device cache when the server cannot be reached', async () => {
    loadTrendHistory.mockReturnValue(new Promise(() => {}));
    getTasks.mockRejectedValue(new Error('down'));
    getCachedTasks.mockResolvedValue([doneToday('c', 'Cached done')]);
    render(<InsightsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /^Completed today: 1/ }));
    expect(screen.getByText('Cached done')).toBeTruthy();
  });

  it('an unexpected reader failure is a calm retry, and retry reloads', async () => {
    loadTrendHistory.mockRejectedValueOnce(new Error('bug'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<InsightsPage />);
    const retry = await screen.findByRole('button', { name: 'Try again' });
    fireEvent.click(retry);
    expect(invalidateTrendHistory).toHaveBeenCalled();
    expect(await screen.findByText('30 tasks in the last 30 days.')).toBeTruthy();
  });

  it('offline: the 7 device days, a plain note, and the page does not look broken', async () => {
    loadTrendHistory.mockResolvedValue({
      coverage: 'device-only', reason: 'browser-offline', points: points(Array.from({ length: 7 }, () => 2)), tasksByDate: {}, today: TODAY, fetchedAt: 0,
    });
    render(<InsightsPage />);
    expect(await screen.findByText(/You're offline/)).toBeTruthy();
    expect(screen.getByText('14 tasks in the last 7 days.')).toBeTruthy();
  });

  it('no streak counter in the trend section (it stays with the Growth Tree, D3)', async () => {
    render(<InsightsPage />);
    await screen.findByText('30 tasks in the last 30 days.');
    expect(screen.queryByText(/streak/i)).toBeNull();
    expect(screen.getByText('tree')).toBeTruthy();
  });

  it('the Growth tree section adds no heading of its own (GrowthTree renders the only one)', async () => {
    render(<InsightsPage />);
    await screen.findByText('tree');
    expect(screen.queryByRole('heading', { name: /growth tree/i })).toBeNull();
    expect(screen.getByRole('region', { name: 'Growth tree' })).toBeTruthy();
  });

  it('the old all-time completion rate is gone (it was a snapshot of whatever tasks still exist)', async () => {
    getTasks.mockResolvedValue({ tasks: [task(), doneToday('d', 'D')] });
    render(<InsightsPage />);
    await screen.findByText('Open tasks');
    expect(screen.queryByText(/completion rate/i)).toBeNull();
  });
});
