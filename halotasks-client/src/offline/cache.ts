import { AuthUser } from '../types/auth';
import { Task } from '../types/task';
import { offlineDb } from './db';
import { TASKS_KEY, withStoreLock } from './storeLock';

const AUTH_USER_KEY = 'auth_user';
const LAST_SYNC_KEY = 'last_sync';

export const getCachedTasks = async (): Promise<Task[]> => {
  return (await offlineDb.get<Task[]>(TASKS_KEY)) ?? [];
};

// Writes go through the store lock, so a whole-list write can never land in the middle of a local mutation's transaction
// (Issue #57). Prefer `updateCachedTasks`, which derives the new list from what is stored; this replaces the list outright.
export const setCachedTasks = async (tasks: Task[]): Promise<void> =>
  withStoreLock(async () => {
    await offlineDb.set(TASKS_KEY, tasks);
  });

/**
 * Applies `update` to the stored task list inside one transaction and returns the list as stored. The list is read in the
 * transaction that replaces it, so concurrent updates (this page's, or another tab's) are applied one after the other and
 * none overwrites another. `seed` is the list to start from only when nothing has been stored yet.
 */
export const updateCachedTasks = (update: (stored: Task[]) => Task[], seed: Task[] = []): Promise<Task[]> =>
  withStoreLock(() =>
    offlineDb.transaction(async (tx) => {
      const next = update((await tx.get<Task[]>(TASKS_KEY)) ?? seed);
      await tx.put(TASKS_KEY, next);
      return next;
    }),
  );

export const getCachedAuthUser = async (): Promise<AuthUser | null> => {
  return await offlineDb.get<AuthUser>(AUTH_USER_KEY);
};

export const setCachedAuthUser = async (user: AuthUser): Promise<void> => {
  await offlineDb.set(AUTH_USER_KEY, user);
};

export const clearCachedAuthUser = async (): Promise<void> => {
  await offlineDb.remove(AUTH_USER_KEY);
};

export const getLastSyncTimestamp = async (): Promise<string | null> => {
  return await offlineDb.get<string>(LAST_SYNC_KEY);
};

export const setLastSyncTimestamp = async (timestamp: string): Promise<void> => {
  await offlineDb.set(LAST_SYNC_KEY, timestamp);
};
