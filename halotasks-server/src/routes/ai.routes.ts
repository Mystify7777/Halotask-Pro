import { Router } from 'express';
import { parseTasks } from '../controllers/ai.controller';
import { requireAuth } from '../middleware/auth.middleware';
import { aiLimiter } from '../middleware/rateLimiters';

const router = Router();

router.use(requireAuth);

router.post('/parse-tasks', aiLimiter, parseTasks);

export default router;
