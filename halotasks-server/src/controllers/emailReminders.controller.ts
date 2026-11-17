import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { getEmailReminderCronSecret, getEmailReminderDailyCap } from '../config/env';
import { createEmailLedger } from '../services/emailLedger';
import { runEmailReminders } from '../services/emailReminderRun';
import { optedInUsers, tasksForUser } from '../services/emailReminderStores';
import { getEmailService } from '../services/emailService';

// -- POST /api/internal/email-reminders/run (Issue #29) --
// The trigger an EXTERNAL scheduler calls every few minutes (Render cron job, GitHub Actions, any cron service). There is no
// timer in this process: a sleeping or restarted server loses nothing, because the next call finds the same work and the
// delivery ledger makes it once-only.
//
// Authentication: `Authorization: Bearer <EMAIL_REMINDER_CRON_SECRET>`, compared in constant time on SHA-256 digests. It is
// not a user route: no user token is accepted, and a user can never reach it. With the secret unset the route does not
// exist (404). The request body and query are ignored: the clock is the server's, never the caller's, and the caller cannot
// choose a user, a task, a time or a recipient.
// Replay-safe: a repeated or concurrent call delivers nothing twice (ledger claims). At most one run executes per process
// at a time; an overlapping call gets 409 and can simply be retried.
// Answers the run's counts only (no address, no task, no provider detail). 200 when the run completed, 503 when no email
// provider is configured (so the scheduler's job visibly fails instead of silently doing nothing).

const NOT_FOUND = { message: 'Not found' };
const RUN_BUDGET_MS = 50_000;

const digest = (value: string) => crypto.createHash('sha256').update(value).digest();

let running = false;

export const runEmailRemindersHandler = async (req: Request, res: Response): Promise<void> => {
  res.set('Cache-Control', 'no-store');

  const secret = getEmailReminderCronSecret();
  if (!secret) {
    res.status(404).json(NOT_FOUND);
    return;
  }

  const header = req.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (presented.length === 0 || !crypto.timingSafeEqual(digest(presented), digest(secret))) {
    res.status(401).json({ message: 'Unauthorized' });
    return;
  }

  if (running) {
    res.status(409).json({ message: 'A run is already in progress' });
    return;
  }

  running = true;
  try {
    const summary = await runEmailReminders({
      now: () => new Date(),
      users: optedInUsers,
      tasksFor: tasksForUser,
      ledger: createEmailLedger(),
      email: getEmailService(),
      appBaseUrl: process.env.APP_BASE_URL,
      dailyCap: getEmailReminderDailyCap(),
      budgetMs: RUN_BUDGET_MS,
      log: console,
    });
    res.status(summary.status === 'unconfigured' ? 503 : 200).json(summary);
  } finally {
    running = false;
  }
};
