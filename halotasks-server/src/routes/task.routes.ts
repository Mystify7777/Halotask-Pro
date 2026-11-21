import { Router } from 'express';
import { createTask, deleteTask, getTasks, syncTasks, updateTask } from '../controllers/task.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';
import { taskSyncLimiter } from '../middleware/rateLimiters';

const router = Router();

router.use(requireAuth);

router.get('/', authenticated(getTasks));
router.post('/', authenticated(createTask));
router.post('/sync', taskSyncLimiter, authenticated(syncTasks));
router.put('/:id', authenticated(updateTask));
router.delete('/:id', authenticated(deleteTask));

export default router;