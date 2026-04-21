import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import nodemailer from 'nodemailer';
import { Resend } from 'resend';
import User from '../models/User.model';

const RESET_TOKEN_TTL_MINUTES = Number(process.env.RESET_TOKEN_TTL_MINUTES ?? 20);
const FORGOT_WINDOW_MS = 15 * 60 * 1000;
const FORGOT_MAX_ATTEMPTS = 5;
const neutralForgotMessage = 'If an account exists for this email, a reset link has been sent.';
const resetEmailSubject = 'Reset your HaloTaskPro password';

const resendApiKey = process.env.RESEND_API_KEY;
const resendClient = resendApiKey ? new Resend(resendApiKey) : null;

// Initialize SMTP transporter if env vars are available
const createSmtpTransporter = () => {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    return null;
  }

  return nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort),
    secure: smtpPort === '465', // Use TLS for port 465
    auth: {
      user: smtpUser,
      pass: smtpPass,
    },
  });
};

const smtpTransporter = createSmtpTransporter();

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

const generateResetCode = () => {
  // Generate 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000));
};

const hashResetCode = (code: string) => {
  return crypto.createHash('sha256').update(code).digest('hex');
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

const buildResetEmailText = (resetCode: string) =>
  [
    'We received a request to reset your password.',
    '',
    `Use the code below. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes.`,
    '',
    `Code: ${resetCode}`,
    '',
    "If you didn't request this, you can ignore this email.",
  ].join('\n');

const buildResetEmailHtml = (resetCode: string) => `
  <div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">
    <p>We received a request to reset your password.</p>
    <p>Use the code below. It expires in ${RESET_TOKEN_TTL_MINUTES} minutes.</p>
    <p style="font-size: 24px; font-weight: bold; letter-spacing: 2px; color: #0f4db2; margin: 16px 0;">
      ${resetCode}
    </p>
    <p>If you didn\'t request this, you can ignore this email.</p>
  </div>
`;

const sendResetPasswordEmail = async (toEmail: string, resetCode: string) => {
  const emailText = buildResetEmailText(resetCode);
  const emailHtml = buildResetEmailHtml(resetCode);
  const fromAddress = process.env.EMAIL_FROM || 'noreply@halotaskpro.com';

  // Try SMTP first (primary transport)
  if (smtpTransporter) {
    try {
      const info = await smtpTransporter.sendMail({
        from: fromAddress,
        to: toEmail,
        subject: resetEmailSubject,
        text: emailText,
        html: emailHtml,
      });

      if (info.messageId) {
        console.info(
          `[Auth] Email delivered via SMTP for ${maskEmail(toEmail)}. Message ID: ${info.messageId}`,
        );
        console.info(`[Auth] Provider: SMTP | Status: SUCCESS | Email: ${maskEmail(toEmail)}`);
        return;
      }
    } catch (smtpError) {
      const errorMessage = smtpError instanceof Error ? smtpError.message : 'Unknown SMTP error';
      console.error(`[Auth] SMTP delivery failed for ${maskEmail(toEmail)}. Error: ${errorMessage}`);
      console.info(`[Auth] Provider: SMTP | Status: FAILED | Error: ${errorMessage}`);
    }
  }

  // Fallback to Resend (secondary transport)
  if (resendClient) {
    try {
      const result = await resendClient.emails.send({
        from: fromAddress,
        to: toEmail,
        subject: resetEmailSubject,
        text: emailText,
        html: emailHtml,
      });

      if (result.error) {
        console.error(
          `[Auth] Resend delivery failed for ${maskEmail(toEmail)}. Error: ${result.error.message}`,
        );
        console.info(`[Auth] Provider: Resend | Status: FAILED | Error: ${result.error.message}`);
      } else if (result.data?.id) {
        console.info(`[Auth] Email delivered via Resend for ${maskEmail(toEmail)}. ID: ${result.data.id}`);
        console.info(`[Auth] Provider: Resend | Status: SUCCESS | Email: ${maskEmail(toEmail)}`);
        return;
      }
    } catch (resendError) {
      const errorMessage = resendError instanceof Error ? resendError.message : 'Unknown Resend error';
      console.error(`[Auth] Resend delivery failed for ${maskEmail(toEmail)}. Error: ${errorMessage}`);
      console.info(`[Auth] Provider: Resend | Status: FAILED | Error: ${errorMessage}`);
    }
  }

  // Final fallback: log code to server logs (no email transport available or both failed)
  if (!smtpTransporter && !resendClient) {
    console.warn('[Auth] No email transport configured (SMTP or Resend). Using demo mode.');
  }
  console.info(`[Auth] Provider: DEMO_MODE | Status: LOGGED | Code for ${maskEmail(toEmail)}: ${resetCode}`);
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
      const resetCode = generateResetCode();
      const hashedCode = hashResetCode(resetCode);
      const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60 * 1000);

      user.resetPasswordTokenHash = hashedCode;
      user.resetPasswordExpiresAt = expiresAt;
      await user.save();

      await sendResetPasswordEmail(normalizedEmail, resetCode);
    }

    return res.json({ message: neutralForgotMessage });
  } catch (error) {
    return next(error);
  }
};

export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { email, token, password } = req.body as {
      email?: string;
      token?: string;
      password?: string;
    };

    if (!email || !token || !password) {
      return res.status(400).json({ message: 'email, token, and password are required' });
    }

    if (password.length < 6) {
      return res.status(400).json({ message: 'password must be at least 6 characters long' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const hashedToken = hashResetCode(token);

    const user = await User.findOne({
      email: normalizedEmail,
      resetPasswordTokenHash: hashedToken,
      resetPasswordExpiresAt: { $gt: new Date() },
    });

    if (!user) {
      return res.status(400).json({ message: 'Reset code is invalid or expired' });
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