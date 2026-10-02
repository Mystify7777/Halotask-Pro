import { Router } from 'express';
import { forgotPassword, loginUser, registerUser, resetPassword } from '../controllers/auth.controller';
import {
  forgotPasswordLimiter,
  loginLimiter,
  registerLimiter,
  resetPasswordLimiter,
} from '../middleware/rateLimiters';

const router = Router();

router.post('/register', registerLimiter, registerUser);
router.post('/login', loginLimiter, loginUser);
router.post('/forgot-password', forgotPasswordLimiter, forgotPassword);
router.post('/reset-password', resetPasswordLimiter, resetPassword);

export default router;
