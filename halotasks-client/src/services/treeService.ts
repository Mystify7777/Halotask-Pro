import { apiClient } from './api';
import type { TreeStateJSON } from '../growth/treeTypes';

export const treeService = {
  /**
   * Fetch the user's current tree state from the server
   */
  getTree: async (): Promise<TreeStateJSON> => {
    const response = await apiClient.get('/tree');
    return response.data.treeState;
  },

  /**
   * Update the user's tree state on the server (fire-and-forget)
   */
  patchTree: async (state: Partial<TreeStateJSON>): Promise<TreeStateJSON> => {
    const response = await apiClient.patch('/tree', state);
    return response.data.treeState;
  },
};
