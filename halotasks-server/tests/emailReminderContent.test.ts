import { describe, expect, it } from 'vitest';
import { buildDigestEmail, buildReminderEmail, cleanTitle, escapeHtml, settingsUrl } from '../src/utils/emailReminderContent';
import { computeDigest, computeReminderEvents, type EngineTask } from '../src/utils/emailReminderEngine';

// Issue #29, sections S3/S6 — the text of the emails. Pure.

const ALL = { dueSoonEnabled: true, overdueEnabled: true, workSessionSoonEnabled: true, startNowEnabled: true, bufferMinutes: 60 as const };
const NOW = Date.parse('2026-10-05T09:00:00Z');
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const eventFor = (t: Partial<EngineTask>) => computeReminderEvents([{ id: 't1', title: 'Write report', completed: false, ...t }], ALL, 'Asia/Kolkata', NOW)[0];

describe('cleanTitle / escapeHtml', () => {
  it('flattens line breaks and control characters (no header injection), trims and bounds', () => {
    expect(cleanTitle('A\r\nBcc: evil@x.test')).toBe('A Bcc: evil@x.test');
    expect(cleanTitle('  tab\tand\u0000nul sep ')).toBe('tab and nul sep');
    expect(cleanTitle('   ')).toBe('Untitled task');
    expect(cleanTitle('x'.repeat(500))).toHaveLength(80);
  });
  it('escapes every HTML metacharacter', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  });
});

describe('buildReminderEmail', () => {
  it('uses the browser notification wording for each type', () => {
    const soon = buildReminderEmail(eventFor({ dueDate: day('2026-10-05'), dueTime: '15:00' }), 'Asia/Kolkata');
    expect(soon.subject).toBe('Task due soon: Write report');
    expect(soon.text).toContain('Write report is due within the next hour (at 3:00 PM).');

    expect(buildReminderEmail(eventFor({ dueDate: day('2026-10-05') }), 'Asia/Kolkata').text).toContain('Write report is due today.');
    expect(buildReminderEmail(eventFor({ dueDate: day('2026-10-05'), dueTime: '14:00' }), 'Asia/Kolkata').text).toContain('Write report is now overdue.');
    expect(buildReminderEmail(eventFor({ startTime: '2026-10-05T09:30:00Z' }), 'Asia/Kolkata').text).toContain('Write report is planned to start soon.');
    expect(buildReminderEmail(eventFor({ startTime: '2026-10-05T09:30:00Z', estimatedMinutes: 90 }), 'Asia/Kolkata').text).toContain('You planned 2h for Write report.');
    expect(buildReminderEmail(eventFor({ startTime: '2026-10-05T08:59:00Z' }), 'Asia/Kolkata').text).toContain('Start Write report now to stay on track.');
    expect(buildReminderEmail(eventFor({ startTime: '2026-10-05T08:00:00Z', dueDate: day('2026-10-05'), dueTime: '16:00' }), 'Asia/Kolkata').text).toContain('to stay on track for 4:00 PM.');
  });

  it('formats times in the given zone', () => {
    const event = eventFor({ dueDate: day('2026-10-05'), dueTime: '15:00' });
    expect(buildReminderEmail(event, 'Asia/Kolkata').text).toContain('3:00 PM');
  });

  it('a hostile title cannot break the subject or inject HTML', () => {
    const email = buildReminderEmail(eventFor({ title: 'Hi\r\nBcc: evil@x.test <img src=x onerror=alert(1)>', dueDate: day('2026-10-05') }), 'Asia/Kolkata');
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.html).not.toContain('<img');
    expect(email.html).toContain('&lt;img');
  });

  it('footer: a link only for a plain http(s) APP_BASE_URL; always how to turn it off; never an address or a secret', () => {
    const event = eventFor({ dueDate: day('2026-10-05') });
    expect(buildReminderEmail(event, 'UTC', 'https://app.example.test/some/path?x=1').text).toContain('https://app.example.test/dashboard/reminders');
    expect(buildReminderEmail(event, 'UTC', 'javascript:alert(1)').text).not.toContain('javascript');
    expect(buildReminderEmail(event, 'UTC', undefined).text).toContain('turn them off');
    expect(settingsUrl('not a url')).toBeNull();
    expect(settingsUrl('ftp://x.test')).toBeNull();
  });
});

describe('buildDigestEmail', () => {
  const tasks: EngineTask[] = [
    { id: 'a', title: 'Overdue <b>one</b>', completed: false, dueDate: day('2026-10-03') },
    { id: 'b', title: 'Big thing', completed: false, dueDate: day('2026-10-05'), dueTime: '18:00', priority: 'high' },
    { id: 'c', title: 'Soon', completed: false, dueDate: day('2026-10-06') },
  ];
  const digest = computeDigest(tasks, { digestEnabled: true, digestTime: '07:30' }, 'Asia/Kolkata', Date.parse('2026-10-05T02:00:00Z'))!;

  it('lists each non-empty section in a fixed order with times and priority', () => {
    const email = buildDigestEmail(digest, 'Asia/Kolkata');
    expect(email.subject).toBe('Your HaloTask Pro day: 3 tasks (Mon, Oct 5)');
    const text = email.text;
    expect(text.indexOf('Overdue:')).toBeLessThan(text.indexOf('Due today:'));
    expect(text.indexOf('Due today:')).toBeLessThan(text.indexOf('Coming up (next 3 days):'));
    expect(text).toContain('- Big thing (at 6:00 PM, high priority)');
    expect(text).toContain('- Soon (Tue, Oct 6)');
  });

  it('escapes titles in the HTML body', () => {
    expect(buildDigestEmail(digest, 'Asia/Kolkata').html).toContain('Overdue &lt;b&gt;one&lt;/b&gt;');
  });

  it('says how many were left out, and the subject counts them', () => {
    const many: EngineTask[] = Array.from({ length: 14 }, (_, n) => ({ id: `m${n}`, title: `T${n}`, completed: false, dueDate: day('2026-10-05') }));
    const big = computeDigest(many, { digestEnabled: true, digestTime: '07:30' }, 'Asia/Kolkata', Date.parse('2026-10-05T02:00:00Z'))!;
    const email = buildDigestEmail(big, 'Asia/Kolkata');
    expect(email.text).toContain('and 4 more');
    expect(email.subject).toContain('14 tasks');
  });

  it('omits an empty section entirely and says "1 task" in the singular', () => {
    const one = computeDigest([tasks[2]], { digestEnabled: true, digestTime: '07:30' }, 'Asia/Kolkata', Date.parse('2026-10-05T02:00:00Z'))!;
    const email = buildDigestEmail(one, 'Asia/Kolkata');
    expect(email.text).not.toContain('Overdue:');
    expect(email.text).not.toContain('Due today:');
    expect(email.subject).toContain('1 task (');
  });
});
