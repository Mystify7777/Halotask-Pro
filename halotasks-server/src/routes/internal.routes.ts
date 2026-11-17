import { Router } from 'express';
import { runEmailRemindersHandler } from '../controllers/emailReminders.controller';
import { internalRunLimiter } from '../middleware/rateLimiters';

const router = Router();

// Deliberately NOT behind requireAuth: callers are schedulers, not users. The controller authenticates the shared secret.
router.post('/email-reminders/run', internalRunLimiter, runEmailRemindersHandler);

export default router;
