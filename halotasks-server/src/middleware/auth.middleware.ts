import { NextFunction, Request, RequestHandler, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.model';
import { JWT_ALGORITHM, parseTokenPayload } from '../utils/authToken';

export type AuthenticatedUser = { id: string; email: string; name: string };

/**
 * A request that has been through `requireAuth`: `user` is guaranteed, not optional. Handlers of protected
 * routes take this type and are registered through `authenticated()`; public routes keep plain `Request`
 * (the global `req.user` stays optional because they exist).
 */
export interface AuthenticatedRequest extends Request {
  user: AuthenticatedUser;
}

const hasAuthenticatedUser = (req: Request): req is AuthenticatedRequest =>
  typeof req.user === 'object' &&
  req.user !== null &&
  typeof req.user.id === 'string' &&
  req.user.id !== '' &&
  typeof req.user.email === 'string' &&
  typeof req.user.name === 'string';

/**
 * Adapts a handler that needs an `AuthenticatedRequest` into an ordinary Express handler. Express's handler
 * type takes a plain `Request`, so a handler cannot simply declare a narrower `req`; this is the one place
 * where the narrowing happens, and it is a runtime check, not a cast. If a protected route was ever wired
 * without `requireAuth`, the request is refused with 401 and the handler never runs (fail closed).
 */
export const authenticated =
  (handler: (req: AuthenticatedRequest, res: Response, next: NextFunction) => unknown): RequestHandler =>
  async (req, res, next) => {
    if (!hasAuthenticatedUser(req)) {
      res.status(401).json({ message: 'Authorization token is required' });
      return;
    }

    await handler(req, res, next);
  };

const invalidToken = (res: Response) => res.status(401).json({ message: 'Invalid or expired token' });

/**
 * Verifies the bearer JWT, then checks it against the account's CURRENT session generation.
 *
 * A valid signature is not enough: the token must also carry the user's current `tokenVersion`
 * (a missing `tv` counts as 0, as does a missing field on the account, so tokens and accounts that
 * predate this check keep working until that user resets their password). A user who no longer
 * exists is rejected. Every rejection is the same 401 so the response never says why.
 *
 * Fails CLOSED: if the lookup itself fails, the request is refused (500), never let through.
 */
export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization token is required' });
  }

  const token = header.slice(7);
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    // JWT_SECRET missing is a server misconfiguration — log it as a critical
    // error but never expose config details in the client-facing response.
    console.error(
      '[Auth] CRITICAL: JWT_SECRET environment variable is not set. ' +
      'All authenticated requests will fail until this is resolved.',
    );
    return res.status(500).json({ message: 'Internal server error' });
  }

  // Pin the algorithm: with a shared secret only HS256 is ever signed, so nothing else is accepted.
  let decoded: unknown;

  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: [JWT_ALGORITHM] });
  } catch {
    return invalidToken(res);
  }

  // A valid signature says nothing about the payload's shape: check it before using any claim, and before
  // spending a database read on a token that cannot be ours.
  const claims = parseTokenPayload(decoded);

  if (!claims) {
    return invalidToken(res);
  }

  try {
    const account = await User.findById(claims.userId).select('tokenVersion').lean();

    if (!account || (account.tokenVersion ?? 0) !== claims.tokenVersion) {
      return invalidToken(res);
    }
  } catch (error) {
    // An id that is not even a valid ObjectId can never belong to an account: that is a bad token.
    if (error instanceof Error && error.name === 'CastError') {
      return invalidToken(res);
    }

    console.error('[Auth] Session lookup failed; refusing the request:', error);
    return res.status(500).json({ message: 'Internal server error' });
  }

  req.user = {
    id: claims.userId,
    email: claims.email,
    name: claims.name,
  };

  return next();
};
