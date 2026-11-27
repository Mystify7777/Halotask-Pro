import { McpServer } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import {
  getProjectContextForUser,
  getProjectSummaryForUser,
  getTaskForUser,
  listSubtasksForUser,
  listTasksForUser,
} from './readService';
import type { McpScope } from './scope';

const textResult = (value: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
});

export const createHaloMcpServer = (scope: McpScope) => {
  const server = new McpServer(
    { name: 'halotask-pro', version: '1.0.0' },
    { maxToolInputElements: 100 },
  );

  const readOnlyAnnotations = {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  } as const;

  server.registerTool(
    'halo_get_project_context',
    {
      title: 'Get HaloTask Project Context',
      description:
        'Returns workspace context for the authenticated HaloTask user. HaloTask currently has no first-class Project entity, so this is derived from the user-scoped task model.',
      annotations: readOnlyAnnotations,
    },
    async () => textResult(await getProjectContextForUser(scope)),
  );

  server.registerTool(
    'halo_list_tasks',
    {
      title: 'List HaloTask Tasks',
      description:
        'Lists tasks belonging only to the authenticated HaloTask user. Supports pagination and optional completion, priority, tag, and text filters.',
      inputSchema: z.object({
        page: z.number().int().min(1).max(10_000).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        completed: z.boolean().optional(),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        tag: z.string().max(100).optional(),
        search: z.string().max(200).optional(),
      }),
      annotations: readOnlyAnnotations,
    },
    async (args) => textResult(await listTasksForUser(scope, args)),
  );

  server.registerTool(
    'halo_get_task',
    {
      title: 'Get HaloTask Task',
      description:
        'Returns one task by id, only when that task belongs to the authenticated HaloTask user.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(100),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ taskId }) => {
      const task = await getTaskForUser(scope, taskId);
      if (!task) {
        return {
          content: [{ type: 'text' as const, text: 'Task not found.' }],
          isError: true,
        };
      }
      return textResult(task);
    },
  );

  server.registerTool(
    'halo_list_subtasks',
    {
      title: 'List HaloTask Subtasks',
      description:
        'Returns the embedded checklist/subtasks for one user-owned task. Subtasks are not first-class entities in the current HaloTask model.',
      inputSchema: z.object({
        taskId: z.string().min(1).max(100),
      }),
      annotations: readOnlyAnnotations,
    },
    async ({ taskId }) => {
      const result = await listSubtasksForUser(scope, taskId);
      if (!result) {
        return {
          content: [{ type: 'text' as const, text: 'Task not found.' }],
          isError: true,
        };
      }
      return textResult(result);
    },
  );

  server.registerTool(
    'halo_get_project_summary',
    {
      title: 'Get HaloTask Project Summary',
      description:
        'Returns an aggregate summary of the authenticated user’s HaloTask workspace. It is derived from task data because the current model has no first-class project entity.',
      annotations: readOnlyAnnotations,
    },
    async () => textResult(await getProjectSummaryForUser(scope)),
  );

  return server;
};
