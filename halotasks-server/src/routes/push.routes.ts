import { Router } from 'express';
import { relay, subscribe, unsubscribe } from '../controllers/push.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import { pushRelayLimiter } from '../middleware/rateLimiters';

const router = Router();

router.use(requireAuth);

router.post('/subscribe', authenticated(subscribe));
router.post('/unsubscribe', authenticated(unsubscribe));
router.post('/relay', pushRelayLimiter, authenticated(relay));

export default router;