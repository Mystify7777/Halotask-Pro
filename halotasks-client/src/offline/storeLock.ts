/**
 * The cache key the task list is stored under, and the ONE lock every read-modify-write of the offline store goes through
 * (Issue #57). The task list and the sync queue live in the same IndexedDB store; the lock keeps this page's writers from
 * interleaving, and each writer also reads its input INSIDE its own IndexedDB transaction, so no write is ever derived from a
 * copy that another write has already replaced.
 */
export const TASKS_KEY = 'tasks';

let chain: Promise<unknown> = Promise.resolve();

export function withStoreLock<T>(fn: () => Promise<T>): Promise<T> {
  const result = chain.then(fn);
  chain = result.catch(() => {});
  return result;
}

/** For tests only. */
export const resetStoreLock = (): void => {
  chain = Promise.resolve();
};
