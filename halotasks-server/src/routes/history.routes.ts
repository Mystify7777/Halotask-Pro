import { Router } from 'express';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import {
  getHistory,
  upsertHistoryForDate,
  upsertTodayHistory,
} from '../controllers/history.controller';

const router = Router();

router.get('/', requireAuth, authenticated(getHistory));
// '/today' must be registered before '/:date' so it is not captured as a date param.
router.put('/today', requireAuth, authenticated(upsertTodayHistory));
router.put('/:date', requireAuth, authenticated(upsertHistoryForDate));

export default router;
