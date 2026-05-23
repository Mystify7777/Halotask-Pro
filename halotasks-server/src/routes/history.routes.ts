import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { getHistory, upsertTodayHistory } from '../controllers/history.controller';

const router = Router();

router.get('/', requireAuth, getHistory);
router.put('/today', requireAuth, upsertTodayHistory);

export default router;
