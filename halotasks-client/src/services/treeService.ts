import { apiClient } from './api';
import type { TreeStateJSON } from '../growth/treeTypes';

export const treeService = {
  /**
   * Fetch the user's current tree state from the server.
   *
   * Read-only by design (Issue #24): XP and the awarded-task ledger are changed only by the server, as a
   * side effect of completing a task, and `PATCH /api/tree` rejects reward fields. There is no write here.
   */
  getTree: async (): Promise<TreeStateJSON> => {
    const response = await apiClient.get('/api/tree');
    return response.data.treeState;
  },
};
