import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #42 — a changed time zone moves the calendar day that date-only reminders are judged in, so the scheduler is
// re-run right away instead of at the next 60-second poll. The scheduler itself is covered in reminders/.

const scheduler = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), runNow: vi.fn(), resetSession: vi.fn() }));

vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => undefined),
  clearCachedAuthUser: vi.fn(async () => undefined),
}));
vi.mock('../reminders/scheduler', () => ({ createReminderScheduler: () => scheduler }));
vi.mock('../reminders/permissions', () => ({
  getNotificationPermissionStatus: () => 'granted',
  isNotificationSupported: () => true,
  requestNotificationPermission: async () => 'granted',
}));
vi.mock('./usePushSubscription', () => ({ relayToServer: vi.fn(), subscribePush: vi.fn() }));

import { useAuthStore } from '../store/authStore';
import { useDashboardReminders } from './useDashboardReminders';

const user = { id: 'u1', email: 'a@b.c', name: 'A' };

beforeEach(() => {
  vi.clearAllMocks();
  useAuthStore.setState({ user });
});

describe('useDashboardReminders and the preferred time zone', () => {
  it('re-runs the reminders when the signed-in user\'s time zone changes, and not for an unrelated change', () => {
    renderHook(() => useDashboardReminders({ getTasks: () => [], setStatusInfo: vi.fn(), setStatusError: vi.fn() }));
    expect(scheduler.start).toHaveBeenCalled();
    scheduler.runNow.mockClear();

    act(() => useAuthStore.setState({ user: { ...user, timeZone: 'Asia/Kolkata' } }));
    expect(scheduler.runNow).toHaveBeenCalledTimes(1);

    act(() => useAuthStore.setState({ user: { ...user, timeZone: 'Asia/Kolkata', name: 'Renamed' } }));
    expect(scheduler.runNow).toHaveBeenCalledTimes(1);

    act(() => useAuthStore.setState({ user: { ...user, timeZone: 'America/Los_Angeles' } }));
    expect(scheduler.runNow).toHaveBeenCalledTimes(2);

    act(() => useAuthStore.setState({ user })); // the saved choice cleared: back to the device zone
    expect(scheduler.runNow).toHaveBeenCalledTimes(3);
  });
});
