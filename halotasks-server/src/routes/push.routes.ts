import { Router } from 'express';
import { relay, subscribe, unsubscribe } from '../controllers/push.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.post('/subscribe', subscribe);
router.post('/unsubscribe', unsubscribe);
router.post('/relay', relay);

export default router;