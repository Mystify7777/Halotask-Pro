import { Response } from 'express';
import User from '../models/User.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { BODY_MUST_BE_OBJECT, isPlainObject } from '../utils/requestBody';
import { parseTimeZoneInput } from '../utils/timeZone';
import { effectiveEmailTimeZone, parseEmailPrefsUpdate, resolveEmailPrefs } from '../utils/emailReminderPrefs';
import { getEmailService, maskEmail } from '../services/emailService';
import bcrypt from 'bcryptjs';
import { createAuthToken, sanitizeUser } from './auth.controller';
import { readRequiredStrings } from '../utils/requestBody';
import { PASSWORD_MIN_LENGTH, isValidPassword } from '../utils/validators';

// -- GET /api/user/preferences --
// Returns { timeZone: string | null }. null means "no saved choice" (the client falls back to the device zone).
//
// -- PUT /api/user/preferences --
// Body: { timeZone: string | null }. A valid IANA identifier saves the choice, null clears it. The field is required
// so a request cannot silently do nothing. Only `timeZone` is written (a $set / $unset of that one path; Mongoose's
// `timestamps` also bumps `updatedAt`, as on every User update), so no other user field can be overwritten. The
// account is always the authenticated one: the id comes from the verified
// token, never from the body or the URL. Responds with the preferences as stored.

const NOT_FOUND = { message: 'User not found' };

export const getPreferences = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const account = await User.findById(req.user.id).select('timeZone').lean();

  if (!account) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  res.json({ timeZone: account.timeZone ?? null });
};

export const updatePreferences = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  if (!isPlainObject(req.body)) {
    res.status(400).json({ message: BODY_MUST_BE_OBJECT });
    return;
  }

  if (!('timeZone' in req.body)) {
    res.status(400).json({ message: 'timeZone is required (an IANA identifier, or null to clear it)' });
    return;
  }

  const parsed = parseTimeZoneInput(req.body.timeZone);

  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const update = parsed.value === null ? { $unset: { timeZone: '' } } : { $set: { timeZone: parsed.value } };
  const account = await User.findByIdAndUpdate(req.user.id, update, { new: true, runValidators: true })
    .select('timeZone')
    .lean();

  if (!account) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  res.json({ timeZone: account.timeZone ?? null });
};

// -- GET / PUT /api/user/email-reminders (Issue #29) --
// The authenticated user's email reminder preferences. The account is always the one in the verified token. PUT takes a
// PARTIAL object of preference fields (see utils/emailReminderPrefs.ts), is strict, and writes only those
// `emailReminders.*` paths in one update. Both answer the preferences as stored (defaults filled in) plus:
//   accountTimeZone    the saved account zone, or null
//   effectiveTimeZone  the zone email scheduling reads in: the override, else the account zone, else UTC
//   available          whether the server has an email provider configured at all (a boolean: no credential, no name)
// Reminders go only to the account's own address; there is no address field.

const emailRemindersResponse = (account: { timeZone?: string | null; emailReminders?: unknown }) => {
  const prefs = resolveEmailPrefs(account.emailReminders);
  return {
    ...prefs,
    accountTimeZone: account.timeZone ?? null,
    effectiveTimeZone: effectiveEmailTimeZone(prefs, account.timeZone),
    available: getEmailService().isConfigured(),
  };
};

export const getEmailReminders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const account = await User.findById(req.user.id).select('timeZone emailReminders').lean();

  if (!account) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  res.json(emailRemindersResponse(account));
};

export const updateEmailReminders = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const parsed = parseEmailPrefsUpdate(req.body);

  if (!parsed.ok) {
    res.status(400).json({ message: parsed.message });
    return;
  }

  const update: Record<string, Record<string, unknown>> = {};
  if (Object.keys(parsed.set).length > 0) update.$set = parsed.set;
  if (parsed.unset.length > 0) update.$unset = Object.fromEntries(parsed.unset.map((path) => [path, '']));

  const account = await User.findByIdAndUpdate(req.user.id, update, { new: true, runValidators: true })
    .select('timeZone emailReminders')
    .lean();

  if (!account) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  res.json(emailRemindersResponse(account));
};

// -- PUT /api/user/password (Issue #46) --
// Body: { currentPassword, newPassword }. The signed-in user changes their own password; the account is the authenticated one.
//
//   - A wrong current password is 403 INVALID_CURRENT_PASSWORD, NEVER 401: the client signs the user out on any 401.
//   - A new password the account already has is 400 PASSWORD_UNCHANGED (compared with bcrypt, so two passwords that
//     share bcrypt's first 72 bytes count as the same one).
//   - One compare-and-set write, filtered on BOTH the hash that was just verified and the tokenVersion observed with it
//     (D3). Today the hash alone would do (every change and reset replaces it, with a fresh salt), but the session
//     generation is the invariant this endpoint exists to move, so it is pinned explicitly: anything that moved either
//     value in between makes the write match nothing (409 PASSWORD_CHANGED_ELSEWHERE) and nothing is written. An account
//     that predates tokenVersion has the field absent, which `$in: [0, null]` matches (a plain 0 would not). The same write sets the new hash, bumps tokenVersion (every
//     other session, and this device's old token, are refused from now on), clears an outstanding reset code and empties
//     the push subscriptions (devices that were signed out must not keep receiving reminders; this one re-subscribes).
//   - The response carries a fresh token for the NEW session generation, so this device stays signed in.
//   - A "password changed" notice goes to the account's own address afterwards, best effort: its failure never changes
//     the answer, and nothing secret is in it or in a log.

const passwordChangedSubject = 'Your HaloTaskPro password was changed';
const passwordChangedText = [
  'The password for your HaloTaskPro account was just changed, and every other signed-in device was signed out.',
  '',
  "If this was you, nothing more is needed.",
  "If it wasn't, reset your password right away with \"Forgot password\" on the sign-in page.",
].join('\n');

const sendPasswordChangedNotice = async (toEmail: string): Promise<void> => {
  try {
    const result = await getEmailService().send(
      { to: toEmail, subject: passwordChangedSubject, text: passwordChangedText },
      'definite-only',
    );
    if (result.status !== 'sent' && result.status !== 'unconfigured') {
      console.error(`[Auth] The password-changed notice to ${maskEmail(toEmail)} was not delivered.`);
    }
  } catch {
    console.error(`[Auth] The password-changed notice to ${maskEmail(toEmail)} could not be sent.`);
  }
};

export const changePassword = async (req: AuthenticatedRequest, res: Response): Promise<void> => {
  const fields = readRequiredStrings(req.body, ['currentPassword', 'newPassword'], {
    required: 'currentPassword and newPassword are required',
    notStrings: 'currentPassword and newPassword must be strings',
  });

  if (!fields.ok) {
    res.status(400).json({ message: fields.message });
    return;
  }

  const { currentPassword, newPassword } = fields.value;

  if (!isValidPassword(newPassword)) {
    res.status(400).json({ code: 'PASSWORD_TOO_SHORT', message: `password must be at least ${PASSWORD_MIN_LENGTH} characters long` });
    return;
  }

  const account = await User.findById(req.user.id).select('passwordHash tokenVersion').lean();

  if (!account) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  if (!(await bcrypt.compare(currentPassword, account.passwordHash))) {
    res.status(403).json({ code: 'INVALID_CURRENT_PASSWORD', message: 'The current password is incorrect' });
    return;
  }

  if (await bcrypt.compare(newPassword, account.passwordHash)) {
    res.status(400).json({ code: 'PASSWORD_UNCHANGED', message: 'The new password must be different from the current one' });
    return;
  }

  const newHash = await bcrypt.hash(newPassword, 10);
  const observedTokenVersion = account.tokenVersion ?? 0;
  // `null` is how Mongo matches an ABSENT field (a plain 0 does not); the schema only ever stores a number or nothing.

  const updated = await User.findOneAndUpdate(
    { _id: req.user.id, passwordHash: account.passwordHash, tokenVersion: observedTokenVersion === 0 ? { $in: [0, null] } : observedTokenVersion },
    {
      $set: { passwordHash: newHash, pushSubscriptions: [] },
      $unset: { resetPasswordTokenHash: 1, resetPasswordExpiresAt: 1 },
      $inc: { tokenVersion: 1 },
    },
    { new: true },
  )
    .select('name email tokenVersion timeZone')
    .lean();

  if (!updated) {
    res.status(409).json({ code: 'PASSWORD_CHANGED_ELSEWHERE', message: 'The password was changed from somewhere else. Please sign in again.' });
    return;
  }

  // Taken from the document the write returned: the new session generation, never a second read.
  const token = createAuthToken(String(updated._id), updated.email, updated.name, updated.tokenVersion ?? 0);

  void sendPasswordChangedNotice(updated.email);

  res.json({ token, user: sanitizeUser(updated), message: 'Password updated. Other devices were signed out.' });
};
