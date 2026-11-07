import { Router } from 'express';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import { postCompletionEvent } from '../controllers/completionEvent.controller';

const router = Router();

router.post('/', requireAuth, authenticated(postCompletionEvent));

export default router;
