import type { EmailService, SendResult } from './emailService';
import type { EmailLedger, LedgerKind } from './emailLedger';
import { buildDigestEmail, buildReminderEmail, type ReminderEmail } from '../utils/emailReminderContent';
import { computeDigest, computeReminderEvents, type EngineTask } from '../utils/emailReminderEngine';
import { effectiveEmailTimeZone, isInQuietHours, resolveEmailPrefs } from '../utils/emailReminderPrefs';

/**
 * One email reminder run (Issue #29, section S5): for every account that opted in, decide what is due NOW and deliver
 * it once. The decision is the pure engine's; the once-only guarantee is the ledger's; the delivery and its fallback
 * are the email service's. This file only connects them, and owns none of their rules.
 *
 *   trigger -> for each opted-in user: quiet hours? -> engine (events + digest) -> ledger claim -> daily cap (counted after the claim,
 *   durable) -> email service ('definite-only') -> ledger settle
 *
 * A run is safe to repeat, overlap or replay at any time: everything it does is either a pure read or a ledger claim.
 * It never writes to a task or an account, so a failing provider cannot affect task data. It is fed by an external
 * scheduler (docs/context.md "Email delivery"): there is no timer in this process.
 */

export type RunUser = { id: string; email: string; timeZone?: string | null; emailReminders?: unknown };

export type RunDeps = {
  /** The instant every decision in this run is made at. */
  now: () => Date;
  users: () => AsyncIterable<RunUser>;
  tasksFor: (userId: string) => Promise<EngineTask[]>;
  ledger: EmailLedger;
  email: EmailService;
  appBaseUrl?: string;
  /** Most emails one account is sent in any rolling 24 hours, enforced against the durable ledger (holds across instances). */
  dailyCap: number;
  /** Stop starting new work after this many ms. The rest is picked up by the next run (nothing is lost or repeated). */
  budgetMs: number;
  log: Pick<Console, 'info' | 'warn' | 'error'>;
};

export type RunSummary = {
  status: 'ok' | 'unconfigured';
  users: number;
  events: number;
  sent: number;
  failed: number;
  unknown: number;
  duplicates: number;
  quiet: number;
  capped: number;
  errors: number;
  truncated: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;

export const runEmailReminders = async (deps: RunDeps): Promise<RunSummary> => {
  const summary: RunSummary = { status: 'ok', users: 0, events: 0, sent: 0, failed: 0, unknown: 0, duplicates: 0, quiet: 0, capped: 0, errors: 0, truncated: false };

  // Nothing is claimed while no provider exists: an event must not be spent on a message that cannot be sent.
  if (!deps.email.isConfigured()) {
    deps.log.warn('[EmailReminders] No email provider is configured; nothing was processed.');
    return { ...summary, status: 'unconfigured' };
  }

  const now = deps.now();
  const started = Date.now();
  const outOfTime = () => Date.now() - started >= deps.budgetMs;

  for await (const user of deps.users()) {
    if (outOfTime()) {
      summary.truncated = true;
      break;
    }
    summary.users += 1;

    try {
      await processUser(user, now, deps, summary, outOfTime);
    } catch {
      // One account's failure (a bad document, a database error) never stops the others. Nothing about it is logged beyond
      // the count: no id, no address, no task text.
      summary.errors += 1;
    }
  }

  deps.log.info(
    `[EmailReminders] run done: users=${summary.users} events=${summary.events} sent=${summary.sent} failed=${summary.failed} ` +
      `unknown=${summary.unknown} duplicates=${summary.duplicates} quiet=${summary.quiet} capped=${summary.capped} ` +
      `errors=${summary.errors} truncated=${summary.truncated}`,
  );
  return summary;
};

const processUser = async (user: RunUser, now: Date, deps: RunDeps, summary: RunSummary, outOfTime: () => boolean): Promise<void> => {
  const prefs = resolveEmailPrefs(user.emailReminders);
  if (!prefs.enabled || typeof user.email !== 'string' || user.email.length === 0) return;

  const zone = effectiveEmailTimeZone(prefs, user.timeZone);
  const instant = now.getTime();

  // Quiet hours hold everything, the digest included. A held reminder is simply not sent while it is quiet; a digest is
  // eligible for the rest of the local day, so it goes out on the first run after quiet hours end.
  if (isInQuietHours(instant, zone, prefs.quietHoursStart, prefs.quietHoursEnd)) {
    summary.quiet += 1;
    return;
  }

  const tasks = await deps.tasksFor(user.id);
  const outgoing: Array<{ kind: LedgerKind; key: string; email: ReminderEmail }> = [];

  for (const event of computeReminderEvents(tasks, prefs, zone, instant)) {
    outgoing.push({ kind: 'task', key: event.key, email: buildReminderEmail(event, zone, deps.appBaseUrl) });
  }
  const digest = computeDigest(tasks, prefs, zone, instant);
  if (digest) outgoing.push({ kind: 'digest', key: digest.key, email: buildDigestEmail(digest, zone, deps.appBaseUrl) });

  if (outgoing.length === 0) return;
  summary.events += outgoing.length;

  let recent = await deps.ledger.countRecent(user.id, new Date(instant - DAY_MS));

  for (const { kind, key, email } of outgoing) {
    if (outOfTime()) {
      summary.truncated = true;
      return;
    }
    if (recent >= deps.dailyCap) {
      summary.capped += 1;
      continue;
    }

    const claim = await deps.ledger.claim(user.id, key, kind, now);
    if (claim.outcome === 'exists') {
      summary.duplicates += 1;
      continue;
    }

    // The cap is enforced AFTER the claim, against the durable ledger, so it holds across server instances: the claim is
    // counted with everything else claimed in the window; if that is over the cap the claim is given back and nothing is
    // sent. Only claims that passed this count ever send, and a sender never releases, so senders in the window <= cap.
    // (Racing instances may both give back, so the cap can under-send a little; it never over-sends.)
    recent = await deps.ledger.countRecent(user.id, new Date(instant - DAY_MS));
    if (recent > deps.dailyCap) {
      summary.capped += 1;
      try {
        await deps.ledger.release(user.id, key, now);
      } catch {
        summary.errors += 1; // stays `claimed`; its lease runs out and it becomes `unknown`: never sent
      }
      continue;
    }

    let result: SendResult;
    try {
      // The recipient is ALWAYS the account's own address, read from the account, never from a task or a request.
      result = await deps.email.send({ to: user.email, subject: email.subject, text: email.text, html: email.html }, 'definite-only');
    } catch {
      result = { status: 'unknown', codes: ['SERVICE_THREW'] }; // the service never throws; if it does, assume it may have sent
    }

    try {
      if (result.status === 'sent') {
        summary.sent += 1;
        await deps.ledger.settle(user.id, key, { state: 'sent', provider: result.provider }, now);
      } else if (result.status === 'unknown') {
        summary.unknown += 1;
        await deps.ledger.settle(user.id, key, { state: 'unknown', code: result.codes.join(',') }, now);
      } else {
        summary.failed += 1;
        await deps.ledger.settle(user.id, key, { state: 'failed', code: result.status === 'failed' ? result.codes.join(',') : 'UNCONFIGURED' }, now);
      }
    } catch {
      // The message was handled but its outcome could not be written. The claim stays `claimed`; when its lease runs out
      // it becomes `unknown`, so it is never sent again.
      summary.errors += 1;
    }
  }
};
