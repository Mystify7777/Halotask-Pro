import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Issue #14: the hook turns a scheduler event into ONE browser notification and ONE relay, with the same payload.

const captured = vi.hoisted(() => ({ onReminder: undefined as undefined | ((event: unknown) => unknown) }));
const relay = vi.hoisted(() => vi.fn());

vi.mock('../offline/cache', () => ({
  setCachedAuthUser: vi.fn(async () => undefined),
  clearCachedAuthUser: vi.fn(async () => undefined),
}));
vi.mock('../reminders/scheduler', () => ({
  createReminderScheduler: (options: { onReminder: (event: unknown) => unknown }) => {
    captured.onReminder = options.onReminder;
    return { start: vi.fn(), stop: vi.fn(), runNow: vi.fn(), resetSession: vi.fn() };
  },
}));
vi.mock('../reminders/permissions', () => ({
  getNotificationPermissionStatus: () => 'granted',
  isNotificationSupported: () => true,
  requestNotificationPermission: async () => 'granted',
}));
vi.mock('./usePushSubscription', () => ({ relayToServer: relay, subscribePush: vi.fn() }));

import { makeTask } from '../test/taskFactory';
import { useDashboardReminders } from './useDashboardReminders';

const created: Array<{ title: string; options: Record<string, unknown> }> = [];
const original = Object.getOwnPropertyDescriptor(globalThis, 'Notification');

beforeEach(() => {
  vi.clearAllMocks();
  created.length = 0;
  class Fake {
    static permission = 'granted';
    constructor(title: string, options: Record<string, unknown>) {
      created.push({ title, options });
    }
  }
  Object.defineProperty(globalThis, 'Notification', { value: Fake, configurable: true, writable: true });
  Object.defineProperty(window, 'Notification', { value: Fake, configurable: true, writable: true });
});
afterEach(() => {
  if (original) Object.defineProperty(globalThis, 'Notification', original);
});

const mount = () => renderHook(() => useDashboardReminders({ getTasks: () => [], setStatusInfo: vi.fn(), setStatusError: vi.fn() }));

describe('useDashboardReminders delivery of a merged reminder', () => {
  it('one notification and one relay, with identical title, body and per-task tag', () => {
    mount();
    const task = makeTask({ _id: 'abc', title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z', dueTime: '17:30' });
    const shown = captured.onReminder?.({ task, type: 'start-now', merged: ['start-now', 'due-soon'] });

    expect(shown).toBe(true);
    expect(created).toHaveLength(1);
    expect(relay).toHaveBeenCalledTimes(1);
    const payload = relay.mock.calls[0][0] as { title: string; body: string; tag: string };
    expect(payload.tag).toBe('halotask-task-abc');
    expect(created[0].title).toBe(payload.title);
    expect(created[0].options).toMatchObject({ body: payload.body, tag: payload.tag });
  });

  it('a calendar-day reminder keeps its per-type tag', () => {
    mount();
    const task = makeTask({ _id: 'abc', title: 'Write report', dueDate: '2026-10-20T00:00:00.000Z' });
    captured.onReminder?.({ task, type: 'due-soon' });
    expect((relay.mock.calls[0][0] as { tag: string }).tag).toBe('halotask-due-soon-abc-2026-10-20T00:00:00.000Z');
  });
});
