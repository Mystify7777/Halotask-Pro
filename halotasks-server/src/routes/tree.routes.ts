import { Router } from 'express';
import { getTree, patchTree } from '../controllers/tree.controller';
import { requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/',   getTree);
router.patch('/', patchTree);

export default router;
