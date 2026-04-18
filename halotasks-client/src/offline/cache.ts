import { AuthUser } from '../types/auth';
import { Task } from '../types/task';
import { offlineDb } from './db';

const TASKS_KEY = 'tasks';
const AUTH_USER_KEY = 'auth_user';
const LAST_SYNC_KEY = 'last_sync';

export const getCachedTasks = async (): Promise<Task[]> => {
  return (await offlineDb.get<Task[]>(TASKS_KEY)) ?? [];
};

export const setCachedTasks = async (tasks: Task[]): Promise<void> => {
  await offlineDb.set(TASKS_KEY, tasks);
};

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
