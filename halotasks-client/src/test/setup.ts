import '@testing-library/jest-dom/vitest';
// Issue #57: the offline layer opens its IndexedDB database when it is imported, and the local-first task mutations use the
// real `idb` code. Every test file gets an in-memory IndexedDB (tests that need a clean database replace the factory).
import 'fake-indexeddb/auto';
