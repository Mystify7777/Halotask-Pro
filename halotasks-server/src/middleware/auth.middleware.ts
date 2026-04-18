import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

type TokenPayload = {
  userId: string;
  email: string;
  name: string;
};

export const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Authorization token is required' });
  }

  const token = header.slice(7);
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    return res.status(500).json({ message: 'JWT_SECRET is not configured' });
  }

  try {
    const payload = jwt.verify(token, jwtSecret) as TokenPayload;

    req.user = {
      id: payload.userId,
      email: payload.email,
      name: payload.name,
    };

    return next();
  } catch {
    return res.status(401).json({ message: 'Invalid or expired token' });
  }
};