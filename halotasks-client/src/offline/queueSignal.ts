/**
 * Tells OTHER tabs of this browser that the durable queue changed (Issue #58), so they re-read how many changes are waiting.
 * It carries no data: a receiver only re-reads the queue length. It does not refresh the task list or replicate any state
 * across tabs. The announcing page's own listener also hears it (each announcement uses its own short-lived channel object,
 * and a page's other channel objects do receive it; verified in Chromium): that costs one extra count re-read, which never
 * announces again, so there is no loop. Without BroadcastChannel (older browsers, tests) nothing happens.
 */
const CHANNEL = 'halotasks-queue';

const open = (): BroadcastChannel | null => {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(CHANNEL) : null;
  } catch {
    return null;
  }
};

export const announceQueueChanged = (): void => {
  const channel = open();
  if (!channel) return;
  try {
    channel.postMessage({ type: 'queue-changed' });
  } catch {
    // a display hint: never worth failing the caller
  } finally {
    channel.close();
  }
};

/** Calls `onChange` when another tab announced a queue change. Returns the unsubscribe function. */
export const onQueueChanged = (onChange: () => void): (() => void) => {
  const channel = open();
  if (!channel) return () => undefined;
  channel.onmessage = (event: MessageEvent) => {
    if ((event.data as { type?: unknown } | null)?.type === 'queue-changed') onChange();
  };
  return () => channel.close();
};
