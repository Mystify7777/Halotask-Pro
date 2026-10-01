import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import {
  getHistory,
  upsertHistoryForDate,
  upsertTodayHistory,
} from '../controllers/history.controller';

const router = Router();

router.get('/', requireAuth, getHistory);
// '/today' must be registered before '/:date' so it is not captured as a date param.
router.put('/today', requireAuth, upsertTodayHistory);
router.put('/:date', requireAuth, upsertHistoryForDate);

export default router;
