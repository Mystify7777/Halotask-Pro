import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Issue #29 — source-level guards for the architecture decisions. They read the source, so they hold for code paths no
// behavioural test happens to exercise.

const SERVER_SRC = path.resolve(__dirname, '../src');
const CLIENT_SRC = path.resolve(__dirname, '../../halotasks-client/src');

const walk = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
const read = (file: string) => fs.readFileSync(file, 'utf8');
const rel = (file: string) => path.relative(SERVER_SRC, file).replace(/\\/g, '/');

describe('no scheduler inside the server process', () => {
  it('there is no setInterval, node-cron or timer-driven loop in src (the trigger is external)', () => {
    const offenders = walk(SERVER_SRC)
      .filter((f) => f.endsWith('.ts'))
      .filter((f) => /\bsetInterval\s*\(|node-cron|\bcron\.schedule|agenda|bullmq|\bbull\b/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

describe('email delivery is not part of task CRUD or any other feature path', () => {
  const crudAndFeatureFiles = [
    'controllers/task.controller.ts',
    'controllers/completionEvent.controller.ts',
    'controllers/history.controller.ts',
    'controllers/tree.controller.ts',
    'controllers/push.controller.ts',
    'routes/task.routes.ts',
    'models/Task.model.ts',
    'utils/taskCompletion.ts',
    'utils/completionRecords.ts',
    'utils/treeAward.ts',
  ];
  it.each(crudAndFeatureFiles)('%s never imports the email service, the ledger or the reminder run', (file) => {
    expect(read(path.join(SERVER_SRC, file))).not.toMatch(/emailService|emailLedger|emailReminder|EmailDelivery/);
  });

  it('only the password-reset, preferences and trigger controllers (and the run, by type) touch the email service', () => {
    const users = walk(SERVER_SRC)
      .filter((f) => f.endsWith('.ts') && /from '(?:\.\.?\/)+(?:services\/)?emailService'/.test(read(f)))
      .map(rel)
      .sort();
    expect(users).toEqual([
      'controllers/auth.controller.ts',
      'controllers/emailReminders.controller.ts',
      'controllers/user.controller.ts',
      'services/emailReminderRun.ts',
    ]);
  });
});

describe('credentials never reach the client', () => {
  it('no email provider variable, secret or endpoint appears anywhere in the client source', () => {
    const offenders = walk(CLIENT_SRC)
      .filter((f) => /\.(ts|tsx|css|html)$/.test(f))
      .filter((f) => /BREVO|SMTP_(HOST|PASS|USER)|EMAIL_REMINDER_CRON_SECRET|api\.brevo\.com|VITE_[A-Z_]*(SMTP|BREVO|CRON)/.test(read(f)))
      .map((f) => path.relative(CLIENT_SRC, f));
    expect(offenders).toEqual([]);
  });

  it('the server never imports nodemailer anywhere except the email service', () => {
    const offenders = walk(SERVER_SRC)
      .filter((f) => f.endsWith('.ts') && /from 'nodemailer'/.test(read(f)))
      .map(rel);
    expect(offenders).toEqual(['services/emailService.ts']);
  });
});
