import { Router } from 'express';
import { changePassword, getEmailReminders, getPreferences, updateEmailReminders, updatePreferences } from '../controllers/user.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import { changePasswordLimiter } from '../middleware/rateLimiters';

const router = Router();

router.use(requireAuth);

router.get('/preferences', authenticated(getPreferences));
router.put('/preferences', authenticated(updatePreferences));
router.get('/email-reminders', authenticated(getEmailReminders));
router.put('/email-reminders', authenticated(updateEmailReminders));
// After requireAuth (router.use above), so the limiter can key on the user.
router.put('/password', changePasswordLimiter, authenticated(changePassword));

export default router;
