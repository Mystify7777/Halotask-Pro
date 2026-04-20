import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Resend } from 'resend';
import User from '../models/User.model';

const RESET_TOKEN_TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MINUTES ?? 20);
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_ATTEMPTS = 5;
const neutralForgotMessage = 'If an account exists for this email, a reset link has been sent.';
const resetEmailSubject = 'Reset your HaloTaskPro password';

const resendApiKey = process.env.RESEND_API_KEY;
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

const forgotAttempts = new Map<string, { count: number; windowStart: number }>();

const createAuthToken = (userId: string, email: string, name: string) => {
  const jwtSecret = process.env.JWT_SECRET;

  if (!jwtSecret) {
    throw new Error('JWT_SECRET is not configured');
  }

  return jwt.sign({ userId, email, name }, jwtSecret, { expiresIn: '7d' });
};

const sanitizeUser = (user: { _id: { toString(): string }; name: string; email: string }) => ({
  id: user._id.toString(),
  name: user.name,
  email: user.email,
});

const buildResetTokenPair = () => {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = crypto.createHash('sha256').update(rawToken).digest('hex');

  return {
    rawToken,
    hashedToken,
  };
};

const getResetUrl = (rawToken: string) => {
  const appBaseUrl = process.env.APP_BASE_URL ?? process.env.CLIENT_ORIGIN ?? 'http://localhost:5173';
  const normalizedBaseUrl = appBaseUrl.endsWith('/') ? appBaseUrl.slice(0, -1) : appBaseUrl;
  return `${normalizedBaseUrl}/reset-password/${rawToken}`;
};

const maskEmail = (email: string) => {
  const [local, domain] = email.split('@');

  if (!local || !domain) {
    return '[invalid-email]';
  }

  if (local.length <= 2) {
    return `**@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
};

const buildResetEmailText = (resetUrl: string) =>
  [
    'We received a request to reset your password.',
    '',
    `Use the link below. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`,
    '',
    resetUrl,
    '',
    "If you didn't request this, you can ignore this email.",
  ].join('\n');

const buildResetEmailHtml = (resetUrl: string) => `
  <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
    <p>We received a request to reset your password.</p>
    <p>Use the link below. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes.</p>
    <p>
      <a href="${resetUrl}" style="display: inline-block; padding: 10px 16px; background: #0f4db2; color: #ffffff; text-decoration: none; border-radius: 6px;">
        Reset Password
      </a>
    </p>
    <p>If you didn\'t request this, you can ignore this email.</p>
  </div>
`;

const sendResetPasswordEmail = async (toEmail: string, resetUrl: string) => {
  const fromAddress = process.env.EMAIL_FROM;

  if (!resendClient || !fromAddress) {
    console.warn('[Auth] Password reset email transport is not configured.');
    return;
  }

  try {
    await resendClient.emails.send({
      from: fromAddress,
      to: toEmail,
      subject: resetEmailSubject,
      text: buildResetEmailText(resetUrl),
      html: buildResetEmailHtml(resetUrl),
    });
  } catch (error) {
    console.error(`[Auth] Failed to send password reset email for ${maskEmail(toEmail)}.`);
  }
};

const canAttemptForgotPassword = (key: string) => {
  const now = Date.now();
  const existing = forgotAttempts.get(key);

  if (!existing || now - existing.windowStart > FORGOT_WINDOW_MS) {
    forgotAttempts.set(key, { count: 1, windowStart: now });
    return true;
  }

  if (existing.count >= FORGOT_MAX_ATTEMPTS) {
    return false;
  }

  existing.count += 1;
  forgotAttempts.set(key, existing);
  return true;
};

export const registerUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { name, email, password } = req.body as {
      name?: string;
      email?: string;
      password?: string;
    };

    if (!name || !email || !password) {
      return res.status(400).json({ message: 'name, email, and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const existingUser = await User.findOne({ email: normalizedEmail });

    if (existingUser) {
      return res.status(409).json({ message: 'Email is already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      passwordHash,
    });

    const token = createAuthToken(user.id, user.email, user.name);

    return res.status(201).json({
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return next(error);
  }
};

export const loginUser = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, password } = req.body as {
      email?: string;
      password?: string;
    };

    if (!email || !password) {
      return res.status(400).json({ message: 'email and password are required' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (!user) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);

    if (!passwordMatches) {
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const token = createAuthToken(user.id, user.email, user.name);

    return res.json({
      token,
      user: sanitizeUser(user),
    });
  } catch (error) {
    return next(error);
  }
};

export const forgotPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email } = req.body as { email?: string };

    if (!email) {
      return res.status(400).json({ message: 'email is required' });
    }

    const limiterKey = req.ip || 'unknown';
    if (!canAttemptForgotPassword(limiterKey)) {
      return res.status(429).json({ message: 'Too many requests. Please try again later.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: normalizedEmail });

    if (user) {
      const { rawToken, hashedToken } = buildResetTokenPair();
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

      user.resetPasswordTokenHash = hashedToken;
      user.resetPasswordExpiresAt = expiresAt;
      await user.save();

      const resetUrl = getResetUrl(rawToken);
      await sendResetPasswordEmail(normalizedEmail, resetUrl);
    }

    return res.json({ message: neutralForgotMessage });
  } catch (error) {
    return next(error);
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, password } = req.body as {
      token?: string;
      password?: string;
    };

    if (!token || !password) {
      return res.status(400).json({ message: 'token and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'password must be at least 6 characters long' });
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.findOne({
      resetPasswordTokenHash: hashedToken,
      resetPasswordExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Reset token is invalid or expired' });
    }

    user.passwordHash = await bcrypt.hash(password, 10);
    user.resetPasswordTokenHash = undefined;
    user.resetPasswordExpiresAt = undefined;
    await user.save();

    return res.json({ message: 'Password updated. Please log in.' });
  } catch (error) {
    return next(error);
  }
};