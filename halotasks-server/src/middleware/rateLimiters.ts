import { RATE_LIMITS } from '../config/rateLimits';
import { createRateLimiter, emailAndIpKey, emailKey, ipKey, userKey } from './rateLimit';

// The limiters actually applied to routes. Each is a list of rules from config/rateLimits.ts; the
// reasoning for the keys is in that file and in docs/context.md.

export const loginLimiter = createRateLimiter([
  { ...RATE_LIMITS.loginIp, key: ipKey },
  { ...RATE_LIMITS.loginAccountIp, key: emailAndIpKey, refundOnSuccess: true },
  { ...RATE_LIMITS.loginAccount, key: emailKey, refundOnSuccess: true },
]);

export const registerLimiter = createRateLimiter([{ ...RATE_LIMITS.registerIp, key: ipKey }]);

export const forgotPasswordLimiter = createRateLimiter([
  { ...RATE_LIMITS.forgotIp, key: ipKey },
  { ...RATE_LIMITS.forgotAccount, key: emailKey },
]);

export const resetPasswordLimiter = createRateLimiter([
  { ...RATE_LIMITS.resetIp, key: ipKey },
  { ...RATE_LIMITS.resetAccount, key: emailKey, refundOnSuccess: true },
]);

// Mounted AFTER requireAuth so the user id is available (Issue #46). Only rejected attempts stay counted for the user.
export const changePasswordLimiter = createRateLimiter([
  { ...RATE_LIMITS.changePasswordUser, key: userKey, refundOnSuccess: true },
  { ...RATE_LIMITS.changePasswordIp, key: ipKey },
]);

// Mounted AFTER requireAuth so the user id is available; unauthenticated requests never reach it.
export const aiLimiter = createRateLimiter([
  { ...RATE_LIMITS.aiUser, key: userKey },
  { ...RATE_LIMITS.aiIp, key: ipKey },
]);

// Mounted AFTER requireAuth (the route list order in routes/task.routes.ts), so the user id is available.
export const taskSyncLimiter = createRateLimiter([{ ...RATE_LIMITS.taskSyncUser, key: userKey }]);

export const pushRelayLimiter = createRateLimiter([{ ...RATE_LIMITS.pushRelayUser, key: userKey }]);

// Mounted BEFORE the secret check on the internal scheduler route, so wrong-secret guesses are counted per source.
export const internalRunLimiter = createRateLimiter([{ ...RATE_LIMITS.internalRunIp, key: ipKey }]);
