import { Response } from 'express';
import User from '../models/User.model';
import { AuthenticatedRequest } from '../middleware/auth.middleware';
import { BODY_MUST_BE_OBJECT, isPlainObject } from '../utils/requestBody';
import { parseTimeZoneInput } from '../utils/timeZone';
import { effectiveEmailTimeZone, parseEmailPrefsUpdate, resolveEmailPrefs } from '../utils/emailReminderPrefs';
import { getEmailService } from '../services/emailService';

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
