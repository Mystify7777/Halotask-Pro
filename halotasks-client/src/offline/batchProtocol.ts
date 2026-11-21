// The wire format of POST /api/tasks/sync (Issue #60). Must match halotasks-server src/services/taskSync.ts.

export type TaskRef = { id: string } | { localId: string };

export type SyncMutation =
  | { mutationId: string; type: 'create'; localId: string; payload: Record<string, unknown> }
  | { mutationId: string; type: 'update'; task: TaskRef; payload: Record<string, unknown> }
  | { mutationId: string; type: 'completion'; task: TaskRef; payload: Record<string, unknown> }
  | { mutationId: string; type: 'delete'; task: TaskRef };

export type SyncError = { httpStatus?: number; code?: string; message: string; blockedBy?: string };

export type SyncResult =
  | { mutationId: string; status: 'applied'; task?: unknown; growth?: unknown; alreadyDeleted?: true }
  | { mutationId: string; status: 'replayed'; task: unknown }
  | { mutationId: string; status: 'rejected'; error: SyncError; retryable: false }
  | { mutationId: string; status: 'failed'; error: SyncError; retryable: true }
  | { mutationId: string; status: 'skipped'; error: SyncError; retryable: true };

export type SyncBatchResponse = { results: SyncResult[] };

/** The most mutations one request may carry (server MAX_SYNC_MUTATIONS). */
export const MAX_BATCH_MUTATIONS = 50;
/** The server's `code` for a request whose shape it refused as a whole. */
export const INVALID_SYNC_REQUEST = 'INVALID_SYNC_REQUEST';
