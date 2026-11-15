import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { addDays, type DayPoint } from '../../insights/trend';
import type { TrendHistory } from '../../insights/trendHistory';
import TrendSection from './TrendSection';

const TODAY = '2026-11-14';
const pts = (counts: (number | null)[]): DayPoint[] =>
  counts.map((c, i) => ({ date: addDays(TODAY, -(counts.length - 1 - i)), completed: c ?? 0, minutes: (c ?? 0) * 10, known: c !== null }));
const rep = (v: number | null, n: number) => Array.from({ length: n }, () => v);
const full = (counts: (number | null)[], tasksByDate: TrendHistory extends never ? never : Record<string, { id: string; title: string; estimatedMinutes: number }[]> = {}): TrendHistory =>
  ({ coverage: 'full', points: pts(counts), tasksByDate, today: TODAY, fetchedAt: 0 });
const device = (counts: (number | null)[], reason: 'browser-offline' | 'unavailable' = 'browser-offline'): TrendHistory =>
  ({ coverage: 'device-only', points: pts(counts), tasksByDate: {}, today: TODAY, reason, fetchedAt: 0 });

const setup = (history: TrendHistory | null, over: Partial<React.ComponentProps<typeof TrendSection>> = {}) => {
  const props = { history, failed: false, range: 30 as const, onRangeChange: vi.fn(), onRetry: vi.fn(), ...over };
  return { props, ...render(<TrendSection {...props} />) };
};

describe('TrendSection states', () => {
  it('loading: a busy skeleton with a status, and no numbers', () => {
    const { container } = setup(null);
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getByRole('status').textContent).toMatch(/Loading/);
    expect(screen.queryByText(/tasks? in the last/)).toBeNull();
  });

  it('empty (no history anywhere): the invitation, no chart, no zeros', () => {
    const { container } = setup(full(rep(null, 90)));
    expect(screen.getByText(/Nothing recorded yet/)).toBeTruthy();
    expect(container.querySelector('.trend-bars')).toBeNull();
    expect(screen.queryByText('0 of 0')).toBeNull();
  });

  it('no activity: says so, no chart of zeros', () => {
    const { container } = setup(full(rep(0, 90)));
    expect(screen.getByText('No tasks completed in the last 30 days.')).toBeTruthy();
    expect(container.querySelector('.trend-bars')).toBeNull();
  });

  it('complete: headline, comparison, chips, bars and the table route', () => {
    const { container } = setup(full([...rep(1, 30), ...rep(1, 30), ...rep(2, 30)]));
    expect(screen.getByText('60 tasks in the last 30 days.')).toBeTruthy();
    expect(screen.getByText(/30 tasks more than the previous 30 days \(\+100%\)\./)).toBeTruthy();
    expect(screen.getByText('active days').previousSibling?.textContent).toBe('30 of 30');
    expect(container.querySelectorAll('.trend-bar')).toHaveLength(30);
    expect(screen.getByText('View as table')).toBeTruthy();
  });

  it('partial: history starts inside the window; unknown days are dashed slots, not zeros', () => {
    const { container } = setup(full([...rep(null, 80), ...rep(1, 10)]));
    expect(screen.getByText(/since your history began on/)).toBeTruthy();
    expect(container.querySelectorAll('.trend-bar.unknown')).toHaveLength(20); // the 30-day window: 20 unknown days
    expect(screen.getByText(/two full periods/)).toBeTruthy();
  });

  it('90 days: weekly bars, and no comparison because there is no earlier period', () => {
    const { container } = setup(full(rep(1, 90)), { range: 90 });
    expect(container.querySelectorAll('.trend-bar')).toHaveLength(13);
    expect(screen.getByText('There is no earlier period to compare with.')).toBeTruthy();
  });

  it('device-only: the calm note, 30 and 90 are disabled, and the 7 days are shown as 7 days', () => {
    setup(device(rep(1, 7)), { range: 7 });
    expect(screen.getByText(/You're offline\. Showing the last 7 days saved on this device/)).toBeTruthy();
    expect((screen.getByRole('button', { name: '30 days' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '90 days' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '7 days' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('device-only asked for 30 days still reports only the days it has', () => {
    setup(device(rep(1, 7), 'unavailable'), { range: 30 });
    expect(screen.getByText('7 tasks in the last 7 days.')).toBeTruthy();
    expect(screen.getByText(/couldn't reach the server/i)).toBeTruthy();
  });

  it('nothing on the device either: a retry, not a blank section', () => {
    const { props } = setup({ coverage: 'device-only', points: [], tasksByDate: {}, today: TODAY, reason: 'unavailable', fetchedAt: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('a failed load: a calm retry', () => {
    const { props } = setup(null, { failed: true });
    expect(screen.getByText(/couldn't load your history/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(props.onRetry).toHaveBeenCalledTimes(1);
  });

  it('a series the model refuses is a retry, never a chart', () => {
    const history = full(rep(1, 14));
    history.points[3] = { ...history.points[3], completed: -2 };
    const { container } = setup(history);
    expect(screen.getByText(/couldn't read your history/i)).toBeTruthy();
    expect(container.querySelector('.trend-bars')).toBeNull();
  });
});

describe('TrendSection range toggle', () => {
  it('three buttons with aria-pressed on the current one; clicking reports the range', () => {
    const { props } = setup(full(rep(1, 90)), { range: 30 });
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '7 days' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    expect(props.onRangeChange).toHaveBeenCalledWith(90);
  });

  it('the group is labelled for assistive technology', () => {
    setup(full(rep(1, 90)));
    expect(screen.getByRole('group', { name: 'History range' })).toBeTruthy();
  });
});

describe('TrendSection 7-day view', () => {
  const tasks = { [TODAY]: [{ id: 'a', title: 'Write report', estimatedMinutes: 30 }] };

  it('opens on today with that day\'s tasks, from the same data as its count', () => {
    setup(full([...rep(0, 20), ...rep(1, 6), 1, ...rep(1, 60)].slice(0, 90), tasks), { range: 7 });
    expect(screen.getByText('Write report')).toBeTruthy();
    expect(screen.getByText('Today')).toBeTruthy();
  });

  it('day buttons have accessible names and toggle the detail by keyboard-activatable buttons', () => {
    setup(full(rep(1, 90), tasks), { range: 7 });
    const days = within(screen.getByRole('list', { name: 'Completions per day' })).getAllByRole('listitem');
    expect(days).toHaveLength(7);
    const last = days[6];
    expect(last.getAttribute('aria-label')).toMatch(/\(today\): 1 task/);
    expect(last.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(last);
    expect(last.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByText('Write report')).toBeNull();
  });

  it('an unknown day says no history was recorded, not "0 tasks"', () => {
    setup(full([...rep(null, 85), ...rep(1, 5)]), { range: 7 });
    const days = within(screen.getByRole('list', { name: 'Completions per day' })).getAllByRole('listitem');
    expect(days[0].getAttribute('aria-label')).toMatch(/no history/);
    fireEvent.click(days[0]);
    expect(screen.getByText('No history was recorded for this day.')).toBeTruthy();
  });

  it('a known day with a count but no names says so', () => {
    setup(full(rep(2, 90)), { range: 7 });
    expect(screen.getByText(/2 completed; no task names were kept for this day/)).toBeTruthy();
  });
});

describe('TrendSection table and pattern', () => {
  it('the table lists every day newest first, with "No history" for unknown days', () => {
    setup(full([...rep(null, 80), ...rep(2, 10)]), { range: 30 });
    const table = screen.getByRole('table');
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(31); // header + 30 days
    expect(within(rows[1]).getAllByRole('cell')[0].textContent).toBe('2');
    expect(within(rows[30]).getAllByRole('cell')[0].textContent).toBe('No history');
  });

  it('90 days: the table is weekly', () => {
    setup(full(rep(1, 90)), { range: 90 });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(14);
    expect(screen.getByRole('columnheader', { name: 'Week' })).toBeTruthy();
  });

  it('the weekday pattern appears only with enough history, and names the leaders', () => {
    // 28 days where Thursdays hold everything
    const counts = Array.from({ length: 90 }, (_, i) => (new Date(Date.UTC(2026, 10, 14) - (89 - i) * 86_400_000).getUTCDay() === 4 ? 3 : 0));
    setup(full(counts));
    expect(screen.getByText(/most tasks on/).textContent).toMatch(/Thursdays/);
  });

  it('no pattern when even the best weekday averages less than one task', () => {
    const counts = rep(0, 90);
    counts[89] = 1;
    setup(full(counts));
    expect(screen.queryByText(/most tasks on/)).toBeNull();
  });

  it('no pattern for a short history', () => {
    setup(full([...rep(null, 80), ...rep(2, 10)]));
    expect(screen.queryByText(/most tasks on/)).toBeNull();
  });
});
