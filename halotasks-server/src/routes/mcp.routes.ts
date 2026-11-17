import { Router } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import { createHaloMcpServer } from '../mcp/server';

const router = Router();

router.use(requireAuth);

router.all(
  '/',
  authenticated(async (req, res, next) => {
    try {
      const handler = createMcpHandler(() => createHaloMcpServer(req.user.id));
      const nodeHandler = toNodeHandler(handler);
      await nodeHandler(req, res, req.body);
    } catch (error) {
      next(error);
    }
  }),
);

export default router;
