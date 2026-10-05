import { Router } from 'express';
import { createTask, deleteTask, getTasks, updateTask } from '../controllers/task.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', authenticated(getTasks));
router.post('/', authenticated(createTask));
router.put('/:id', authenticated(updateTask));
router.delete('/:id', authenticated(deleteTask));

export default router;