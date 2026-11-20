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
  /**
   * Runs `fn` inside ONE readwrite transaction on the store: every `get` and `put` it makes commits together or not at all,
   * and the transaction is the serialization point, so what `fn` reads is what it is replacing (Issue #57). `fn` must only
   * await the accessors it is given (a transaction closes as soon as nothing is pending); if it throws, nothing is written.
   */
  transaction: async <T>(
    fn: (tx: { get: <V>(key: string) => Promise<V | null>; put: (key: string, value: unknown) => Promise<void> }) => Promise<T>,
  ): Promise<T> => {
    const database = await dbPromise;
    const transaction = database.transaction(CACHE_STORE, 'readwrite');
    const store = transaction.objectStore(CACHE_STORE);
    // A request that fails rejects `done` as well; it is observed below, so it is never an unhandled rejection.
    const done = transaction.done.then(
      () => null,
      (error: unknown) => ({ error }),
    );
    let result: T;
    try {
      result = await fn({
        get: async <V,>(key: string) => {
          const entry = await store.get(key);
          return entry ? (entry.value as V) : null;
        },
        put: async (key, value) => {
          await store.put({ value, updatedAt: new Date().toISOString() }, key);
        },
      });
    } catch (error) {
      try {
        transaction.abort();
      } catch {
        // already finished or aborted
      }
      await done;
      throw error;
    }
    const outcome = await done;
    if (outcome) throw outcome.error;
    return result;
  },
  remove: async (key: string): Promise<void> => {
    const database = await dbPromise;
    await database.delete(CACHE_STORE, key);
  },
};
