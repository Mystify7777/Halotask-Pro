import { Router } from 'express';
import { getPreferences, updatePreferences } from '../controllers/user.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/preferences', authenticated(getPreferences));
router.put('/preferences', authenticated(updatePreferences));

export default router;
