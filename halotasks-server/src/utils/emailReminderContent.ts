import { dueDayKey, exactDeadline, type Digest, type DigestSection, type EngineTask, type ReminderEvent } from './emailReminderEngine';

/**
 * The text of reminder and digest emails (Issue #29). Pure: no clock, no environment, no I/O. The wording follows the
 * browser notifications (client `reminders/notification.ts`). A task title is the user's own text, so it is stripped of
 * line breaks and control characters before it goes anywhere near a subject line, truncated, and HTML-escaped in the
 * HTML body. Nothing here contains an address, a token or any credential.
 */

export type ReminderEmail = { subject: string; text: string; html: string };

const TITLE_MAX = 80;

/** One line, no control characters, bounded. Prevents header injection through a subject and keeps lines short. */
export const cleanTitle = (title: string): string => {
  // eslint-disable-next-line no-control-regex
  const flat = title.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  const text = flat.length > 0 ? flat : 'Untitled task';
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
};

export const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const timeIn = (instant: number, timeZone: string): string =>
  new Date(instant).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone });

const dayLabel = (day: string): string =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** The settings page the footer points at, when the deployment's APP_BASE_URL is a plain http(s) origin; else null. */
export const settingsUrl = (appBaseUrl: string | undefined): string | null => {
  if (!appBaseUrl) return null;
  try {
    const url = new URL(appBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return `${url.origin}/dashboard/reminders`;
  } catch {
    return null;
  }
};

const footerText = (appBaseUrl: string | undefined): string => {
  const link = settingsUrl(appBaseUrl);
  return ['', '--', 'You get this because email reminders are turned on in HaloTask Pro.', link ? `Change or turn them off: ${link}` : 'You can turn them off in HaloTask Pro under Reminders.'].join('\n');
};

const footerHtml = (appBaseUrl: string | undefined): string => {
  const link = settingsUrl(appBaseUrl);
  return `<p style="color:#6b7280;font-size:12px;margin-top:24px;">You get this because email reminders are turned on in HaloTask Pro. ${
    link ? `<a href="${escapeHtml(link)}">Change or turn them off</a>.` : 'You can turn them off in HaloTask Pro under Reminders.'
  }</p>`;
};

const wrapHtml = (inner: string, appBaseUrl: string | undefined) =>
  `<div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5;">${inner}${footerHtml(appBaseUrl)}</div>`;

const REMINDER_HEADINGS: Record<ReminderEvent['type'], string> = {
  'due-soon': 'Task due soon',
  overdue: 'Task overdue',
  'work-session-soon': 'Planned work session should begin soon',
  'start-now': 'Start now to finish on time',
};

const reminderBody = (event: ReminderEvent, timeZone: string): string => {
  const title = cleanTitle(event.task.title);
  const exact = event.deadline;

  switch (event.type) {
    case 'due-soon':
      return exact === null ? `${title} is due today.` : `${title} is due within the next hour (at ${timeIn(exact, timeZone)}).`;
    case 'overdue':
      return `${title} is now overdue.`;
    case 'work-session-soon': {
      const minutes = event.task.estimatedMinutes ?? 0;
      if (!(minutes > 0)) return `${title} is planned to start soon.`;
      const hours = Math.ceil(minutes / 60);
      return `You planned ${hours > 0 ? `${hours}h` : `${minutes}m`} for ${title}. Consider starting soon.`;
    }
    default:
      return exact !== null ? `Start ${title} now to stay on track for ${timeIn(exact, timeZone)}.` : `Start ${title} now to stay on track.`;
  }
};

/** The email for one reminder event. `timeZone` is the user's effective email zone. */
export const buildReminderEmail = (event: ReminderEvent, timeZone: string, appBaseUrl?: string): ReminderEmail => {
  const heading = REMINDER_HEADINGS[event.type];
  const body = reminderBody(event, timeZone);
  return {
    subject: `${heading}: ${cleanTitle(event.task.title)}`,
    text: `${body}${footerText(appBaseUrl)}`,
    html: wrapHtml(`<p style="font-size:16px;font-weight:bold;margin:0 0 8px;">${escapeHtml(heading)}</p><p style="margin:0;">${escapeHtml(body)}</p>`, appBaseUrl),
  };
};

// ── Digest ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const taskLine = (task: EngineTask, timeZone: string, withDay: boolean): string => {
  const parts: string[] = [];
  const day = dueDayKey(task.dueDate);
  const exact = exactDeadline(task, timeZone);
  if (withDay && day) parts.push(dayLabel(day));
  if (exact !== null) parts.push(`at ${timeIn(exact, timeZone)}`);
  if (task.priority === 'high') parts.push('high priority');
  return `${cleanTitle(task.title)}${parts.length ? ` (${parts.join(', ')})` : ''}`;
};

const SECTIONS: Array<{ key: 'overdue' | 'today' | 'upcoming'; heading: string; withDay: boolean }> = [
  { key: 'overdue', heading: 'Overdue', withDay: true },
  { key: 'today', heading: 'Due today', withDay: false },
  { key: 'upcoming', heading: 'Coming up (next 3 days)', withDay: true },
];

const sectionLines = (section: DigestSection, timeZone: string, withDay: boolean): string[] => [
  ...section.tasks.map((task) => taskLine(task, timeZone, withDay)),
  ...(section.more > 0 ? [`and ${section.more} more`] : []),
];

export const buildDigestEmail = (digest: Digest, timeZone: string, appBaseUrl?: string): ReminderEmail => {
  const total = digest.overdue.tasks.length + digest.overdue.more + digest.today.tasks.length + digest.today.more + digest.upcoming.tasks.length + digest.upcoming.more;
  const subject = `Your HaloTask Pro day: ${total} task${total === 1 ? '' : 's'} (${dayLabel(digest.day)})`;

  const textParts: string[] = [`Your tasks for ${dayLabel(digest.day)}.`];
  const htmlParts: string[] = [`<p style="font-size:16px;font-weight:bold;margin:0 0 8px;">Your tasks for ${escapeHtml(dayLabel(digest.day))}</p>`];

  for (const { key, heading, withDay } of SECTIONS) {
    const lines = sectionLines(digest[key], timeZone, withDay);
    if (lines.length === 0) continue;
    textParts.push('', `${heading}:`, ...lines.map((line) => `- ${line}`));
    htmlParts.push(`<p style="font-weight:bold;margin:16px 0 4px;">${escapeHtml(heading)}</p><ul style="margin:0;padding-left:20px;">${lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`);
  }

  return { subject, text: `${textParts.join('\n')}${footerText(appBaseUrl)}`, html: wrapHtml(htmlParts.join(''), appBaseUrl) };
};
