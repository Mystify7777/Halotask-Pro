import { Router } from 'express';
import { getTree, patchTree } from '../controllers/tree.controller';
import { authenticated, requireAuth } from '../middleware/auth.middleware';

const router = Router();

router.use(requireAuth);

router.get('/', authenticated(getTree));
router.patch('/', authenticated(patchTree));

export default router;
