import { act, renderHook, waitFor } from '@testing-library/react';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '../types/task';
import { resetOfflineStore, queuedEntries, TEST_USER } from '../test/dashboardTasksHarness';
import { useAuthStore } from '../store/authStore';
import { resetSyncQueueState } from '../offline/syncQueue';

// Issue #58: what the person is told about synchronization, end to end. The REAL offline layer (fake-indexeddb), the REAL
// queue processor and the REAL hooks; only the network edge (taskService) is a double. A "tab" is one mounted pair of hooks
// over the shared database. fake-indexeddb and Node's BroadcastChannel do not prove a real browser's multi-tab behaviour
// (see the Chromium check recorded with this issue). BroadcastChannel is a small in-process shim with the same contract
// (same name, asynchronous delivery; the shim skips the sending object, a real browser also reaches the sending page's other channel objects, which only costs one extra re-read).

vi.mock('../offline/history', () => ({ updateTodaySnapshot: vi.fn(async () => undefined) }));
vi.mock('../services/taskService', () => ({
  taskService: { createTask: vi.fn(), updateTask: vi.fn(), deleteTask: vi.fn(), getTasks: vi.fn() },
}));

import { taskService } from '../services/taskService';
import { useDashboardSync } from './useDashboardSync';
import { useDashboardTasks } from './useDashboardTasks';

class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  onmessage: ((event: MessageEvent) => void) | null = null;
  constructor(readonly name: string) {
    FakeBroadcastChannel.open.add(this);
  }
  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.open) {
      if (other !== this && other.name === this.name) setTimeout(() => other.onmessage?.({ data } as MessageEvent), 0);
    }
  }
  close() {
    FakeBroadcastChannel.open.delete(this);
  }
}

const submit = { preventDefault: () => undefined } as unknown as FormEvent<HTMLFormElement>;
const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { response: { status } });
const networkError = () => Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' });

// The tiny server behind the double: creates are stored, the list is what was stored.
let serverTasks: Task[] = [];
let serverSeq = 0;
const serverCreates = vi.fn();

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const acceptCreate = async (payload: Partial<Task>) => {
  serverCreates(payload.title);
  serverSeq += 1;
  const task = { ...payload, _id: `srv-${serverSeq}`, completed: false } as Task;
  serverTasks.push(task);
  return { task };
};

type TabProps = { online: boolean };
const mountTab = async (online: boolean) => {
  const view = renderHook(
    ({ online: isOnline }: TabProps) => {
      const [tasks, setTasks] = useState<Task[]>([]);
      const bridge = useRef({ refreshPendingQueueCount: async () => 0, requestSync: () => undefined as void });
      const [loading, setLoading] = useState(true);
      const hook = useDashboardTasks({
        tasks,
        setTasks,
        isOnline,
        syncBridgeRef: bridge,
        previewGrowthForCompletion: () => undefined,
        setStatusError: () => undefined,
        setStatusInfo: () => undefined,
      });
      const sync = useDashboardSync({
        isOnline,
        persistTasks: hook.persistTasks,
        setLoadingTasks: setLoading,
        setStatusError: () => undefined,
        setStatusInfo: () => undefined,
        setTasks: hook.setTasks,
      });
      bridge.current.refreshPendingQueueCount = sync.refreshPendingQueueCount;
      bridge.current.requestSync = sync.requestSync;
      return { hook, sync, tasks, loading };
    },
    { initialProps: { online } },
  );
  const create = async (title: string) => {
    act(() => view.result.current.hook.setTitle(title));
    await act(() => view.result.current.hook.handleCreateTask(submit));
  };
  const kind = () => view.result.current.sync.syncState.kind;
  const state = () => view.result.current.sync.syncState;
  return Object.assign(view, { create, kind, state, setOnline: (next: boolean) => view.rerender({ online: next }) });
};

beforeEach(async () => {
  vi.clearAllMocks();
  serverTasks = [];
  serverSeq = 0;
  await resetOfflineStore();
  vi.mocked(taskService.createTask).mockImplementation(((payload: Partial<Task>) => acceptCreate(payload)) as never);
  vi.mocked(taskService.getTasks).mockImplementation((async () => ({ tasks: [...serverTasks], page: 1, limit: 0, hasMore: false })) as never);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.unstubAllGlobals());

describe('opening the app', () => {
  it('claims nothing until a synchronization actually succeeded, then says synced', async () => {
    const gate = deferred<{ tasks: Task[] }>();
    vi.mocked(taskService.getTasks).mockReturnValueOnce(gate.promise as never);
    const tab = await mountTab(true);
    expect(tab.kind()).toBe('unverified'); // not "syncing", not "synced": the list is still being read
    expect(tab.state().confirmedAt).toBeNull();
    await act(async () => gate.resolve({ tasks: [] }));
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    expect(tab.state().confirmedAt).not.toBeNull();
  });

  it('opened while the server is unreachable: still no "synced"', async () => {
    vi.mocked(taskService.getTasks).mockRejectedValue(networkError());
    const tab = await mountTab(true);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(tab.kind()).toBe('unverified');
    expect(tab.state().confirmedAt).toBeNull();
  });
});

describe('mutation while online', () => {
  it('pending -> syncing while the request is out -> synced only after the server accepted it', async () => {
    const tab = await mountTab(true);
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    const before = tab.state().confirmedAt;

    const gate = deferred<{ task: Task }>();
    vi.mocked(taskService.createTask).mockImplementationOnce((async (payload: Partial<Task>) => {
      await gate.promise;
      return acceptCreate(payload);
    }) as never);

    await tab.create('Write report');
    await waitFor(() => expect(tab.kind()).toBe('syncing'));
    expect(tab.state().pending).toBe(1);
    expect(tab.state().confirmedAt).toBeNull(); // the earlier "synced" no longer describes this device
    expect(tab.result.current.tasks[0].pendingSync).toBe(true);

    await act(async () => gate.resolve({ task: {} as Task }));
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    expect(tab.state().pending).toBe(0);
    expect(tab.state().confirmedAt).not.toBeNull();
    expect(tab.state().confirmedAt! >= before!).toBe(true);
    expect(await queuedEntries()).toEqual([]);
    expect(tab.result.current.tasks[0].pendingSync).toBe(false);
  });
});

describe('mutation while offline, and reconnect', () => {
  it('offline: stored on this device (count), nothing sent, never "synced"; reconnect sends it and only then says synced', async () => {
    const tab = await mountTab(false);
    await tab.create('Offline one');
    expect(tab.kind()).toBe('offline');
    expect(tab.state().pending).toBe(1);
    expect(taskService.createTask).not.toHaveBeenCalled();

    act(() => tab.setOnline(true));
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    expect(serverCreates).toHaveBeenCalledTimes(1);
    expect(tab.state().pending).toBe(0);
  });

  it('several mutations queued offline: the count follows the queue, and reconnect delivers every one exactly once', async () => {
    const tab = await mountTab(false);
    await tab.create('A');
    await tab.create('B');
    await tab.create('C');
    expect(tab.state()).toMatchObject({ kind: 'offline', pending: 3 });
    expect((await queuedEntries()).length).toBe(3);

    act(() => tab.setOnline(true));
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    expect(serverCreates.mock.calls.map((c) => c[0])).toEqual(['A', 'B', 'C']);
    expect(tab.state().pending).toBe(0);
  });

  it('offline with nothing queued just says offline (no claim about data)', async () => {
    const tab = await mountTab(false);
    expect(tab.state()).toMatchObject({ kind: 'offline', pending: 0 });
  });
});

describe('transient failure', () => {
  it('attention/unreachable, the work is kept, never "synced"; a later successful retry clears it', async () => {
    const tab = await mountTab(true);
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    vi.mocked(taskService.createTask).mockRejectedValueOnce(networkError());

    await tab.create('Flaky');
    await waitFor(() => expect(tab.kind()).toBe('attention'));
    expect(tab.state()).toMatchObject({ blocked: 'unreachable', rejected: 0, pending: 1, confirmedAt: null });
    expect(tab.result.current.sync.rejectionNotices).toEqual([]); // not a refusal
    expect((await queuedEntries()).length).toBe(1);

    await act(() => tab.result.current.sync.handleRetrySync());
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    expect(serverCreates).toHaveBeenCalledTimes(1);
  });

  it('several queued, the server fails midway: the sent ones are gone from the count, the rest stay and are reported', async () => {
    const tab = await mountTab(false);
    await tab.create('A');
    await tab.create('B');
    await tab.create('C');
    vi.mocked(taskService.createTask)
      .mockImplementationOnce(((p: Partial<Task>) => acceptCreate(p)) as never)
      .mockRejectedValue(httpError(503)); // the server stays down for the rest of the run

    act(() => tab.setOnline(true));
    await waitFor(() => expect(tab.kind()).toBe('attention'));
    expect(tab.state()).toMatchObject({ blocked: 'unreachable', pending: 2 });
    expect(serverCreates).toHaveBeenCalledTimes(1);
  });

  it('a 401 is auth, a different thing from unreachable, and nothing is lost', async () => {
    const tab = await mountTab(true);
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    vi.mocked(taskService.createTask).mockRejectedValueOnce(httpError(401));
    await tab.create('Needs sign-in');
    await waitFor(() => expect(tab.kind()).toBe('attention'));
    expect(tab.state()).toMatchObject({ blocked: 'auth', rejected: 0, pending: 1 });
    expect((await queuedEntries()).length).toBe(1);
  });

  it('the failure verdict is about the past: going offline replaces it with "offline"', async () => {
    const tab = await mountTab(true);
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    vi.mocked(taskService.createTask).mockRejectedValueOnce(networkError());
    await tab.create('x');
    await waitFor(() => expect(tab.kind()).toBe('attention'));
    act(() => tab.setOnline(false));
    expect(tab.state()).toMatchObject({ kind: 'offline', pending: 1 });
  });
});

describe('permanent rejection', () => {
  it('is its own state: the server received it and refused; it is not pending any more and stays until dismissed', async () => {
    const tab = await mountTab(true);
    await waitFor(() => expect(tab.kind()).toBe('synced'));
    vi.mocked(taskService.createTask).mockRejectedValueOnce(httpError(400));

    await tab.create('Refused');
    await waitFor(() => expect(tab.kind()).toBe('attention'));
    expect(tab.state()).toMatchObject({ blocked: null, rejected: 1, pending: 0 });
    expect(tab.result.current.sync.rejectionNotices[0].message).toMatch(/Not saved: the server rejected the new task “Refused”/);
    expect(await queuedEntries()).toEqual([]);

    // survives later activity until the person dismisses it
    await tab.create('Fine');
    await waitFor(() => expect(serverCreates).toHaveBeenCalledWith('Fine'));
    expect(tab.kind()).toBe('attention');

    act(() => tab.result.current.sync.dismissRejections());
    await waitFor(() => expect(tab.kind()).toBe('synced'));
  });
});

describe('reload with a pending queue', () => {
  it('a fresh tab over the same database shows the stored work as not synced, never "synced", until a drain succeeds', async () => {
    const first = await mountTab(false);
    await first.create('Left over 1');
    await first.create('Left over 2');
    first.unmount();
    resetSyncQueueState(); // a new page load: no in-memory queue state survives

    const gate = deferred<{ task: Task }>();
    vi.mocked(taskService.createTask).mockImplementation((() => gate.promise) as never);
    const reopened = await mountTab(true);
    await waitFor(() => expect(reopened.kind()).toBe('syncing'));
    expect(reopened.state()).toMatchObject({ pending: 2, confirmedAt: null });

    // the server stays away: the work is reported, not claimed
    await act(async () => gate.reject(networkError()));
    await waitFor(() => expect(reopened.kind()).toBe('attention'));
    expect(reopened.state()).toMatchObject({ blocked: 'unreachable', pending: 2, confirmedAt: null });
  });

  it('reopened offline: the stored count is shown from the queue', async () => {
    const first = await mountTab(false);
    await first.create('Left over');
    first.unmount();
    const reopened = await mountTab(false);
    await waitFor(() => expect(reopened.state()).toMatchObject({ kind: 'offline', pending: 1 }));
    expect(TEST_USER.id).toBeTruthy();
    expect(useAuthStore.getState().user?.id).toBe(TEST_USER.id);
  });
});

describe('two tabs', () => {
  beforeEach(() => vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel));

  it('tab B learns the queue changed and re-reads the count, but never claims a sync it did not observe', async () => {
    const a = await mountTab(true);
    const b = await mountTab(true);
    await waitFor(() => expect(a.kind()).toBe('synced'));
    await waitFor(() => expect(b.kind()).toBe('synced'));

    const gate = deferred<void>();
    vi.mocked(taskService.createTask).mockImplementationOnce((async (p: Partial<Task>) => {
      await gate.promise;
      return acceptCreate(p);
    }) as never);
    await a.create('From tab A');

    await waitFor(() => expect(b.state().pending).toBe(1)); // told by the signal; B did nothing itself
    expect(b.kind()).toBe('pending'); // honest: B cannot see A's drain, and its old "synced" no longer describes the device
    expect(b.state().confirmedAt).toBeNull();

    await act(async () => gate.resolve());
    await waitFor(() => expect(a.kind()).toBe('synced'));
    await waitFor(() => expect(b.state().pending).toBe(0));
    // B read an empty queue, which proves nothing about a successful sync: it claims nothing (not "synced").
    expect(b.kind()).toBe('unverified');
    expect(b.state().confirmedAt).toBeNull();
  });

  it('a queue count read by another tab never creates a confirmation', async () => {
    const a = await mountTab(false);
    const b = await mountTab(false);
    await a.create('x');
    await waitFor(() => expect(b.state().pending).toBe(1));
    expect(b.state().confirmedAt).toBeNull();
  });
});
