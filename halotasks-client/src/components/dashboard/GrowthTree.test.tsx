import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import GrowthTree from './GrowthTree';
import type { TreeState } from '../../growth/treeTypes';

// Issue #16 — the widget labels the cached state for today's UTC day, per status, and never implies that
// XP or the stage was lost.

const state = (over: Partial<TreeState>): TreeState => ({
  xp: 130, leaves: 6, streakDays: 5, lastActiveDate: '2026-10-06', health: 'healthy', stage: 'mature',
  lastCalculatedAt: '2026-10-06T00:00:00.000Z', awardedTaskIds: new Set(), ...over,
});

describe('GrowthTree status copy', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-06T10:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  it.each([
    ['active', '2026-10-06', 5, 'Healthy', '5 days', 'Active Today', /grew your tree today/],
    ['at_risk', '2026-10-05', 5, 'Healthy', '5 days', 'Last active yesterday', /Complete a task today to keep your streak/],
    ['wilting', '2026-10-04', 5, 'Wilting', '0 days', '2d since last', /missed a day.*wilting.*XP and stage are safe/],
    ['dead', '2026-10-02', 5, 'Needs Care', '0 days', '4d since last', /XP, leaves and stage are safe/],
  ])('%s', (_status, last, streak, health, streakText, hint, message) => {
    render(<GrowthTree state={state({ lastActiveDate: last, streakDays: streak })} />);

    expect(screen.getByText(health)).toBeTruthy();
    expect(screen.getByText(streakText)).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
    expect(screen.getByText(message)).toBeTruthy();
    // XP, leaves and stage are shown exactly as stored, whatever the status.
    expect(screen.getByText('130 XP')).toBeTruthy();
    expect(screen.getByText(/^6 /)).toBeTruthy();
    expect(screen.getByText('Mature Tree')).toBeTruthy();
  });

  it('unstarted user: no health row, no hint, plant-a-seed copy', () => {
    render(<GrowthTree state={state({ xp: 0, leaves: 0, streakDays: 0, lastActiveDate: null, stage: 'seed', health: 'dead' })} />);
    expect(screen.queryByText('Health')).toBeNull();
    expect(screen.getByText('Complete your first task to plant a seed.')).toBeTruthy();
  });

  it('recovery: the same tree shown again after one completion is healthy at once, with the grown XP', () => {
    const { rerender } = render(<GrowthTree state={state({ lastActiveDate: '2026-10-01', streakDays: 5 })} />);
    expect(screen.getByText('Needs Care')).toBeTruthy();
    rerender(<GrowthTree state={state({ lastActiveDate: '2026-10-06', streakDays: 1, xp: 140, leaves: 7 })} />);
    expect(screen.getByText('Healthy')).toBeTruthy();
    expect(screen.getByText('140 XP')).toBeTruthy();
  });
});
