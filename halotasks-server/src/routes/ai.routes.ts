import { Router } from 'express';
import { parseTasks } from '../controllers/ai.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.post('/parse-tasks', parseTasks);

export default router;
