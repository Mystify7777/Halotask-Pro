import { Router } from 'express';
import { getEmailReminders, getPreferences, updateEmailReminders, updatePreferences } from '../controllers/user.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/preferences', authenticated(getPreferences));
router.put('/preferences', authenticated(updatePreferences));
router.get('/email-reminders', authenticated(getEmailReminders));
router.put('/email-reminders', authenticated(updateEmailReminders));

export default router;
