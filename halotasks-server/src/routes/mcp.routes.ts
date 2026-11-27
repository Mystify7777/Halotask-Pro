import { Router } from 'express';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import { mcpLimiter } from '../middleware/rateLimiters';
import { createHaloMcpServer } from '../mcp/server';
import { personalScope } from '../mcp/scope';

export const mcpRouter = Router();
const router = mcpRouter;

// Order matters: authentication first (so the limiter can key on the user), then the limiter, then the handler.
router.use(requireAuth);
router.use(mcpLimiter);

router.all(
  '/',
  authenticated(async (req, res, next) => {
    try {
      // Stateless: a fresh server per request, bound to the authenticated user's scope (never to anything in the request body).
      const handler = createMcpHandler(() => createHaloMcpServer(personalScope(req.user.id)));
      await toNodeHandler(handler)(req, res, req.body);
    } catch (error) {
      next(error);
    }
  }),
);

export default router;
