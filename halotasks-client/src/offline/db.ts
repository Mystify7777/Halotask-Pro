import { DBSchema, openDB } from 'idb';

type OfflineCacheValue = {
  value: unknown;
  updatedAt: string;
};

interface HaloTasksOfflineDB extends DBSchema {
  cache: {
    key: string;
    value: OfflineCacheValue;
  };
}

const DB_NAME = 'halotasks-offline';
const DB_VERSION = 1;
const CACHE_STORE = 'cache';

const dbPromise = openDB<HaloTasksOfflineDB>(DB_NAME, DB_VERSION, {
  upgrade(database) {
    if (!database.objectStoreNames.contains(CACHE_STORE)) {
      database.createObjectStore(CACHE_STORE);
    }
  },
});

export const offlineDb = {
  get: async <T>(key: string): Promise<T | null> => {
    const database = await dbPromise;
    const entry = await database.get(CACHE_STORE, key);
    if (!entry) {
      return null;
    }

    return entry.value as T;
  },
  set: async <T>(key: string, value: T): Promise<void> => {
    const database = await dbPromise;
    await database.put(CACHE_STORE, {
      value,
      updatedAt: new Date().toISOString(),
    }, key);
  },
  remove: async (key: string): Promise<void> => {
    const database = await dbPromise;
    await database.delete(CACHE_STORE, key);
  },
};
