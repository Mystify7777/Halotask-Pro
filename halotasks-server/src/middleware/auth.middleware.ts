import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import User from '../models/User.model';

type TokenPayload = {
  userId: string;
  email: string;
  name: string;
  /** Session generation the token was issued under. Absent on tokens that predate it (= 0). */
  tv?: number;
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

  let payload: TokenPayload;

  try {
    payload = jwt.verify(token, jwtSecret) as TokenPayload;
  } catch {
    return invalidToken(res);
  }

  const tokenVersion = payload.tv === undefined ? 0 : payload.tv;

  if (typeof payload.userId !== 'string' || !Number.isInteger(tokenVersion) || tokenVersion < 0) {
    return invalidToken(res);
  }

  try {
    const account = await User.findById(payload.userId).select('tokenVersion').lean();

    if (!account || (account.tokenVersion ?? 0) !== tokenVersion) {
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
    id: payload.userId,
    email: payload.email,
    name: payload.name,
  };

  return next();
};
