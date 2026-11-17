import { describe, expect, it, vi } from 'vitest';
import { createEmailLedger, LEASE_MS } from '../src/services/emailLedger';
import { runEmailReminders, type RunSummary, type RunUser } from '../src/services/emailReminderRun';
import type { EngineTask } from '../src/utils/emailReminderEngine';
import { createEmailDeliveryDouble, createEmailServiceDouble } from './helpers/emailDoubles';

// Issue #29, sections S3-S6 — a whole reminder run against in-memory stores, a strict ledger double and a scripted email
// service. It proves the run's decisions and its once-only behaviour. It does NOT prove that a real provider accepts mail
// or that MongoDB enforces the unique index (staging / tests/emailDelivery.realmongo.test.ts).

const A = '665f1c2e9b1e8a00000000a1';
const B = '665f1c2e9b1e8a00000000b2';
const IST = 'Asia/Kolkata';
const NOW = Date.parse('2026-10-05T09:00:00Z'); // 14:30 IST, outside the default quiet hours (22:30-07:00)
const day = (d: string) => new Date(`${d}T00:00:00Z`);
const task = (over: Partial<EngineTask> & { id: string }): EngineTask => ({ title: `Task ${over.id}`, completed: false, priority: 'medium', ...over });
const silent = { info: () => undefined, warn: () => undefined, error: () => undefined };

type World = { users: RunUser[]; tasks: Record<string, EngineTask[]>; now: number };

const harness = (initial: Partial<World> & { configured?: boolean } = {}) => {
  const world: World = { users: [], tasks: {}, now: NOW, ...initial };
  const store = createEmailDeliveryDouble();
  const mail = createEmailServiceDouble(initial.configured ?? true);
  let ledger = createEmailLedger(store.model);

  const run = (over: { dailyCap?: number; budgetMs?: number; tasksFor?: (id: string) => Promise<EngineTask[]> } = {}): Promise<RunSummary> =>
    runEmailReminders({
      now: () => new Date(world.now),
      users: async function* () {
        for (const user of world.users) yield user;
      },
      tasksFor: over.tasksFor ?? (async (id) => world.tasks[id] ?? []),
      ledger,
      email: mail.service,
      appBaseUrl: 'https://app.example.test',
      dailyCap: over.dailyCap ?? 20,
      budgetMs: over.budgetMs ?? 60_000,
      log: silent,
    });

  return {
    world,
    ...store,
    mail,
    run,
    /** A process restart: new ledger object over the SAME persisted documents. */
    restart: () => {
      ledger = createEmailLedger(store.model);
    },
  };
};

const user = (id: string, over: Partial<RunUser> & { prefs?: Record<string, unknown> } = {}): RunUser => ({
  id,
  email: `${id.slice(-2)}@example.test`,
  timeZone: IST,
  emailReminders: { enabled: true, ...over.prefs },
  ...(over.email ? { email: over.email } : {}),
});

const dueSoonTask = (id = 't1') => task({ id, dueDate: day('2026-10-05'), dueTime: '15:00' }); // due in 30 min

describe('delivery', () => {
  it('sends one email through the service with the at-most-once policy to the ACCOUNT address', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    const summary = await h.run();
    expect(summary).toMatchObject({ status: 'ok', users: 1, events: 1, sent: 1, failed: 0, unknown: 0, errors: 0 });
    expect(h.mail.sent).toHaveLength(1);
    expect(h.mail.sent[0].policy).toBe('definite-only');
    expect(h.mail.sent[0].message.to).toBe('a1@example.test');
    expect(h.mail.sent[0].message.subject).toBe('Task due soon: Task t1');
    expect(h.docs[0]).toMatchObject({ userId: A, state: 'sent', provider: 'smtp', kind: 'task' });
  });

  it('both providers down (definite): recorded as failed, counted, nothing else breaks', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.mail.script.push({ status: 'failed', codes: ['smtp:EAUTH', 'brevo:HTTP_401'] });
    const summary = await h.run();
    expect(summary).toMatchObject({ sent: 0, failed: 1, unknown: 0 });
    expect(h.docs[0]).toMatchObject({ state: 'failed', lastCode: 'smtp:EAUTH,brevo:HTTP_401' });
  });

  it('an ambiguous failure is recorded as unknown', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.mail.script.push({ status: 'unknown', codes: ['smtp:ETIMEDOUT'] });
    expect(await h.run()).toMatchObject({ unknown: 1, sent: 0 });
    expect(h.docs[0].state).toBe('unknown');
  });

  it('a service that THROWS is treated as unknown, never as an exception out of the run', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.mail.script.push('throw');
    const summary = await h.run();
    expect(summary).toMatchObject({ unknown: 1, errors: 0 });
    expect(h.docs[0]).toMatchObject({ state: 'unknown', lastCode: 'SERVICE_THREW' });
  });

  it('the run only READS tasks: a failing provider leaves task data exactly as it was', async () => {
    const tasks = [Object.freeze(dueSoonTask())] as EngineTask[];
    const snapshot = JSON.stringify(tasks);
    const h = harness({ users: [user(A)], tasks: { [A]: tasks } });
    h.mail.script.push('throw');
    await h.run();
    expect(JSON.stringify(tasks)).toBe(snapshot);
  });

  it('a provider that was configured but is gone mid-run is a retryable failure, not a lost event', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.mail.script.push({ status: 'unconfigured' });
    await h.run();
    expect(h.docs[0]).toMatchObject({ state: 'failed', lastCode: 'UNCONFIGURED' });
  });
});

describe('no email provider configured', () => {
  it('processes nothing and claims nothing, so no event is spent on a message that cannot be sent', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] }, configured: false });
    expect(await h.run()).toMatchObject({ status: 'unconfigured', users: 0, sent: 0 });
    expect(h.docs).toHaveLength(0);
    expect(h.mail.sent).toHaveLength(0);
  });
});

describe('idempotency', () => {
  it('the same run twice sends once (scheduler replay)', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    await h.run();
    const second = await h.run();
    expect(h.mail.sent).toHaveLength(1);
    expect(second).toMatchObject({ sent: 0, duplicates: 1 });
  });

  it('later polls inside the same window send nothing more', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    for (const minutes of [0, 5, 10, 15, 20]) {
      h.world.now = NOW + minutes * 60_000;
      await h.run();
    }
    expect(h.mail.sent).toHaveLength(1);
  });

  it('a process restart between runs sends nothing again (the ledger is the memory, not the process)', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    await h.run();
    h.restart();
    await h.run();
    expect(h.mail.sent).toHaveLength(1);
  });

  it('two overlapping runs send once', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask('t1'), dueSoonTask('t2')] } });
    const [one, two] = await Promise.all([h.run(), h.run()]);
    expect(h.mail.sent).toHaveLength(2); // one email per task, not four
    expect(one.sent + two.sent).toBe(2);
    expect(h.docs.map((d) => d.eventKey).sort()).toHaveLength(2);
  });

  it('retry after a DEFINITE failure: the next run delivers it, as attempt 2', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.mail.script.push({ status: 'failed', codes: ['smtp:ECONNREFUSED'] });
    await h.run();
    h.world.now = NOW + 5 * 60_000;
    const retry = await h.run();
    expect(retry).toMatchObject({ sent: 1, failed: 0 });
    expect(h.mail.sent).toHaveLength(2);
    expect(h.docs[0]).toMatchObject({ state: 'sent', attempts: 2 });
    h.world.now = NOW + 10 * 60_000;
    await h.run();
    expect(h.mail.sent).toHaveLength(2);
  });

  it('retries stop at the attempt budget', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    for (let i = 0; i < 6; i += 1) {
      h.mail.script.push({ status: 'failed', codes: ['smtp:EAUTH'] });
      h.world.now = NOW + i * 60_000;
      await h.run();
    }
    expect(h.mail.sent).toHaveLength(3);
    expect(h.docs[0]).toMatchObject({ state: 'failed', attempts: 3 });
  });

  it('AMBIGUOUS failure is never retried: five more runs, still one attempt', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.mail.script.push({ status: 'unknown', codes: ['smtp:ETIMEDOUT'] });
    await h.run();
    for (let i = 1; i <= 5; i += 1) {
      h.world.now = NOW + i * 60_000;
      await h.run();
    }
    expect(h.mail.sent).toHaveLength(1);
  });

  it('a run that dies mid-send (claimed, never settled) is not repeated by the next run, even after its lease', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    // The dead run's trace: a claim and nothing else.
    await createEmailLedger(h.model).claim(A, 'task:due-soon:t1:2026-10-05:t15:00@Asia/Kolkata', 'task', new Date(NOW));
    h.world.now = NOW + LEASE_MS + 60_000; // still inside the 60-minute window? deadline is NOW+30m
    await h.run();
    expect(h.mail.sent).toHaveLength(0);
    expect(h.docs[0].state).toBe('unknown');
  });

  it('an outcome that cannot be written never causes a second send', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    h.faults.failSettle = true;
    expect(await h.run()).toMatchObject({ sent: 1, errors: 1 });
    h.faults.failSettle = false;
    h.world.now = NOW + LEASE_MS + 1000;
    await h.run();
    expect(h.mail.sent).toHaveLength(1);
  });

  it('editing a task\'s title or priority after it was reminded does not remind again; changing its due time does', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    await h.run();
    h.world.tasks[A] = [{ ...dueSoonTask(), title: 'Renamed', priority: 'high' }];
    await h.run();
    expect(h.mail.sent).toHaveLength(1);
    h.world.tasks[A] = [{ ...dueSoonTask(), dueTime: '15:20' }];
    await h.run();
    expect(h.mail.sent).toHaveLength(2);
  });
});

describe('preferences', () => {
  it('email disabled (the default for every account) sends nothing', async () => {
    const h = harness({ users: [user(A, { prefs: { enabled: false } }), { id: B, email: 'b@x.test', timeZone: IST }], tasks: { [A]: [dueSoonTask()], [B]: [dueSoonTask()] } });
    const summary = await h.run();
    expect(summary.sent).toBe(0);
    expect(h.mail.sent).toHaveLength(0);
  });

  it('enabled sends; turning it off again stops further events', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask('t1')] } });
    await h.run();
    expect(h.mail.sent).toHaveLength(1);
    h.world.users = [user(A, { prefs: { enabled: false } })];
    h.world.tasks[A] = [dueSoonTask('t2')];
    await h.run();
    expect(h.mail.sent).toHaveLength(1);
  });

  it('quiet hours hold every email, in the EMAIL time zone; the same instant sends outside them', async () => {
    const quiet = Date.parse('2026-10-05T17:30:00Z'); // 23:00 IST, inside 22:30-07:00
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 't1', dueDate: day('2026-10-05'), dueTime: '23:30' })] } });
    h.world.now = quiet;
    expect(await h.run()).toMatchObject({ quiet: 1, sent: 0, events: 0 });
    expect(h.mail.sent).toHaveLength(0);

    // The same wall-clock reality in a zone where it is the afternoon: not quiet.
    h.world.users = [user(A, { prefs: { timeZone: 'America/Los_Angeles' } })];
    h.world.tasks[A] = [task({ id: 't2', dueDate: day('2026-10-05'), dueTime: '11:00' })]; // 11:00 PDT = 18:00Z
    expect(await h.run()).toMatchObject({ quiet: 0, sent: 1 });
  });

  it('the email-zone OVERRIDE beats the account zone, and the account zone is the default', async () => {
    // 09:00Z = 14:30 IST (not quiet) but = 02:00 in Los Angeles (quiet).
    const base = { users: [user(A)], tasks: { [A]: [dueSoonTask()] } };
    const followAccount = harness(base);
    expect(await followAccount.run()).toMatchObject({ quiet: 0, sent: 1 });
    const override = harness({ users: [user(A, { prefs: { timeZone: 'America/Los_Angeles' } })], tasks: { [A]: [dueSoonTask()] } });
    expect(await override.run()).toMatchObject({ quiet: 1, sent: 0 });
  });

  it('with no account zone and no override the email zone is UTC (never a guessed device zone)', async () => {
    const h = harness({ users: [{ id: A, email: 'a@x.test', timeZone: null, emailReminders: { enabled: true } }], tasks: { [A]: [task({ id: 't', dueDate: day('2026-10-05'), dueTime: '09:30' })] } });
    expect(await h.run()).toMatchObject({ sent: 1 }); // 09:30 UTC is 30 minutes after 09:00Z
  });

  it('per-type toggles are honoured', async () => {
    const tasks = [dueSoonTask('soon'), task({ id: 'late', dueDate: day('2026-10-05'), dueTime: '14:00' })];
    const h = harness({ users: [user(A, { prefs: { dueSoonEnabled: false } })], tasks: { [A]: tasks } });
    await h.run();
    expect(h.mail.sent.map((m) => m.message.subject)).toEqual(['Task overdue: Task late']);
  });

  it('browser reminders being off has no effect: email has its own switch (the browser settings never reach the server)', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    expect(await h.run()).toMatchObject({ sent: 1 });
  });
});

describe('user isolation', () => {
  it("each account gets only ITS tasks, at ITS address; one user's failure does not stop the next", async () => {
    const h = harness({ users: [user(A), user(B)], tasks: { [A]: [dueSoonTask('mine')], [B]: [dueSoonTask('yours')] } });
    await h.run();
    const byRecipient = Object.fromEntries(h.mail.sent.map((m) => [m.message.to, m.message.subject]));
    expect(byRecipient).toEqual({ 'a1@example.test': 'Task due soon: Task mine', 'b2@example.test': 'Task due soon: Task yours' });
  });

  it('the same task key for two users is two separate events', async () => {
    const h = harness({ users: [user(A), user(B)], tasks: { [A]: [dueSoonTask('same')], [B]: [dueSoonTask('same')] } });
    await h.run();
    expect(h.mail.sent).toHaveLength(2);
    expect(new Set(h.docs.map((d) => d.userId))).toEqual(new Set([A, B]));
  });

  it('an error loading one user\'s tasks is counted and the other users are still served', async () => {
    const h = harness({ users: [user(A), user(B)], tasks: { [B]: [dueSoonTask('ok')] } });
    const summary = await h.run({
      tasksFor: async (id) => {
        if (id === A) throw new Error('db hiccup with secret-text');
        return h.world.tasks[id] ?? [];
      },
    });
    expect(summary).toMatchObject({ errors: 1, sent: 1 });
    expect(h.mail.sent[0].message.to).toBe('b2@example.test');
  });

  it('a user with no usable address is skipped', async () => {
    const h = harness({ users: [{ id: A, email: '', timeZone: IST, emailReminders: { enabled: true } }], tasks: { [A]: [dueSoonTask()] } });
    expect(await h.run()).toMatchObject({ sent: 0, events: 0 });
  });
});

describe('scheduling through a whole run', () => {
  it('start-time reminder (work-session-soon, then start-now)', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 's', startTime: '2026-10-05T09:30:00Z' })] } });
    await h.run();
    expect(h.mail.sent.map((m) => m.message.subject)).toEqual(['Planned work session should begin soon: Task s']);
    h.world.now = Date.parse('2026-10-05T09:31:00Z');
    await h.run();
    expect(h.mail.sent.map((m) => m.message.subject)).toEqual(['Planned work session should begin soon: Task s', 'Start now to finish on time: Task s']);
  });

  it('due-time reminder uses the exact deadline, and overdue follows once it passes', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask()] } });
    await h.run();
    h.world.now = Date.parse('2026-10-05T09:31:00Z'); // 15:01 IST: past the deadline
    await h.run();
    expect(h.mail.sent.map((m) => m.message.subject)).toEqual(['Task due soon: Task t1', 'Task overdue: Task t1']);
  });

  it('date-only task: "due today" on its day, "overdue" the next day, nothing two days later; one each', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 'd', dueDate: day('2026-10-05') })] } });
    for (const iso of ['2026-10-05T04:00:00Z', '2026-10-05T09:00:00Z', '2026-10-06T04:00:00Z', '2026-10-06T09:00:00Z', '2026-10-07T09:00:00Z']) {
      h.world.now = Date.parse(iso);
      await h.run();
    }
    expect(h.mail.sent.map((m) => m.message.subject)).toEqual(['Task due soon: Task d', 'Task overdue: Task d']);
  });

  it('start and due time together produce each reminder once, never two sets', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 'b', startTime: '2026-10-05T08:00:00Z', dueDate: day('2026-10-05'), dueTime: '15:00' })] } });
    await h.run();
    await h.run();
    expect(h.mail.sent.map((m) => m.message.subject).sort()).toEqual(['Start now to finish on time: Task b', 'Task due soon: Task b']);
  });

  it('boundaries: not at 61 minutes before, yes at exactly 60, nothing for a completed task', async () => {
    const t = task({ id: 'x', dueDate: day('2026-10-05'), dueTime: '15:30' }); // deadline 10:00Z
    const h = harness({ users: [user(A)], tasks: { [A]: [t] } });
    h.world.now = Date.parse('2026-10-05T08:59:00Z');
    expect(await h.run()).toMatchObject({ events: 0 });
    h.world.now = Date.parse('2026-10-05T09:00:00Z');
    expect(await h.run()).toMatchObject({ sent: 1 });
    h.world.tasks[A] = [{ ...t, id: 'y', completed: true }];
    expect(await h.run()).toMatchObject({ events: 0 });
  });

  it('an old overdue task does not send when email is first turned on', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 'old', dueDate: day('2026-09-01'), dueTime: '10:00' }), task({ id: 'older', dueDate: day('2026-08-01') })] } });
    expect(await h.run()).toMatchObject({ events: 0, sent: 0 });
  });
});

describe('daily digest', () => {
  const digestPrefs = { digestEnabled: true, digestTime: '07:30' };
  const tasks = [task({ id: 'o', title: 'Overdue', dueDate: day('2026-10-03') }), task({ id: 'd', title: 'Today', dueDate: day('2026-10-05') }), task({ id: 'u', title: 'Soon', dueDate: day('2026-10-07') })];
  const MORNING = Date.parse('2026-10-05T02:30:00Z'); // 08:00 IST

  it('is OFF by default: an account that never enabled it gets reminders only', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: tasks } });
    h.world.now = MORNING;
    await h.run();
    expect(h.mail.sent.some((m) => m.message.subject.startsWith('Your HaloTask Pro day'))).toBe(false);
  });

  it('once enabled it is sent once per local day, at or after its time', async () => {
    const h = harness({ users: [user(A, { prefs: digestPrefs })], tasks: { [A]: tasks } });
    h.world.now = Date.parse('2026-10-05T01:59:00Z'); // 07:29 IST: not yet
    await h.run();
    expect(h.mail.sent.filter((m) => m.message.subject.startsWith('Your HaloTask'))).toHaveLength(0);

    for (const iso of ['2026-10-05T02:00:00Z', '2026-10-05T02:05:00Z', '2026-10-05T10:00:00Z']) {
      h.world.now = Date.parse(iso);
      await h.run();
    }
    const digests = h.mail.sent.filter((m) => m.message.subject.startsWith('Your HaloTask'));
    expect(digests).toHaveLength(1);
    expect(digests[0].message.text).toContain('Overdue:');
    expect(digests[0].message.text).toContain('Due today:');
    expect(h.docs.find((d) => d.kind === 'digest')!.eventKey).toBe('digest:2026-10-05');

    h.world.now = Date.parse('2026-10-06T02:30:00Z'); // the next local day
    await h.run();
    expect(h.mail.sent.filter((m) => m.message.subject.startsWith('Your HaloTask'))).toHaveLength(2);
  });

  it('is deferred by quiet hours, then sent on the first run after they end', async () => {
    const h = harness({ users: [user(A, { prefs: { ...digestPrefs, digestTime: '06:00', quietHoursStart: '22:30', quietHoursEnd: '08:00' } })], tasks: { [A]: tasks } });
    h.world.now = Date.parse('2026-10-05T01:00:00Z'); // 06:30 IST: after digest time but inside quiet hours
    expect(await h.run()).toMatchObject({ quiet: 1, sent: 0 });
    h.world.now = Date.parse('2026-10-05T02:30:00Z'); // 08:00 IST: quiet ended
    await h.run();
    expect(h.mail.sent.filter((m) => m.message.subject.startsWith('Your HaloTask'))).toHaveLength(1);
  });

  it('an empty digest is never sent', async () => {
    const h = harness({ users: [user(A, { prefs: digestPrefs })], tasks: { [A]: [task({ id: 'far', dueDate: day('2026-12-25') })] } });
    h.world.now = MORNING;
    expect(await h.run()).toMatchObject({ events: 0, sent: 0 });
  });
});

describe('bounds', () => {
  it('the daily cap stops further emails for that account only', async () => {
    const many = ['a', 'b', 'c', 'd'].map((id) => dueSoonTask(id));
    const h = harness({ users: [user(A), user(B)], tasks: { [A]: many, [B]: [dueSoonTask('solo')] } });
    const summary = await h.run({ dailyCap: 2 });
    expect(summary).toMatchObject({ sent: 3, capped: 2 });
    expect(h.mail.sent.filter((m) => m.message.to === 'a1@example.test')).toHaveLength(2);
    expect(h.mail.sent.filter((m) => m.message.to === 'b2@example.test')).toHaveLength(1);
  });

  it('the cap counts the rolling 24 hours already sent, across runs', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask('a'), dueSoonTask('b')] } });
    await h.run({ dailyCap: 1 });
    h.world.now = NOW + 60_000;
    // `capped` counts events held back while the account is at its cap (the one already sent is still due, so it counts too).
    expect(await h.run({ dailyCap: 1 })).toMatchObject({ sent: 0, capped: 2, duplicates: 0 });
    expect(h.mail.sent).toHaveLength(1);
  });

  it('the cap holds across instances: two runs racing on one account never send more than the cap', async () => {
    const h = harness({ users: [user(A)] });
    const ids = (prefix: string) => ['1', '2', '3', '4'].map((n) => dueSoonTask(`${prefix}${n}`));
    // Two "instances" with different snapshots (so different event keys) share one ledger and interleave.
    const [one, two] = await Promise.all([
      h.run({ dailyCap: 3, tasksFor: async () => ids('x') }),
      h.run({ dailyCap: 3, tasksFor: async () => ids('y') }),
    ]);
    expect(h.mail.sent.length).toBeLessThanOrEqual(3);
    expect(one.sent + two.sent).toBe(h.mail.sent.length);
    expect(one.capped + two.capped).toBeGreaterThan(0);
    // Nothing is stuck: every claim is sent or given back, and the given-back events are still claimable.
    expect(h.docs.filter((d) => d.state === 'claimed')).toHaveLength(0);
    expect(h.docs.filter((d) => d.state === 'sent')).toHaveLength(h.mail.sent.length);
  });

  it('a failed give-back never sends and leaves the claim to expire as unknown', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [dueSoonTask('a')] } });
    const realCount = h.model.countDocuments.bind(h.model);
    (h.model as unknown as { countDocuments: unknown }).countDocuments = async (f: never) => (await realCount(f)) + (h.docs.length > 0 ? 100 : 0); // under the cap before the claim, over it once counted
    h.faults.failSettle = true; // the release write fails
    const summary = await h.run({ dailyCap: 5 });
    expect(h.mail.sent).toHaveLength(0);
    expect(summary).toMatchObject({ sent: 0, capped: 1, errors: 1 });
    expect(h.docs[0]?.state).toBe('claimed');
  });

  it('a spent time budget stops the run cleanly; the remaining work is not lost, the next run does it', async () => {
    const h = harness({ users: [user(A), user(B)], tasks: { [A]: [dueSoonTask('a')], [B]: [dueSoonTask('b')] } });
    expect(await h.run({ budgetMs: 0 })).toMatchObject({ truncated: true, sent: 0, users: 0 });
    expect(await h.run()).toMatchObject({ truncated: false, sent: 2 });
  });
});

describe('what is stored and logged', () => {
  it('the ledger holds identity and outcome only: no address, subject, body or title', async () => {
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 't1', title: 'Secret Plan', dueDate: day('2026-10-05'), dueTime: '15:00' })] } });
    await h.run();
    const stored = JSON.stringify(h.docs);
    for (const leak of ['Secret Plan', '@example.test', 'Task due soon']) expect(stored).not.toContain(leak);
  });

  it('the run logs counts only', async () => {
    const lines: string[] = [];
    const logger = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error: (m: string) => lines.push(m) };
    const h = harness({ users: [user(A)], tasks: { [A]: [task({ id: 't1', title: 'Secret Plan', dueDate: day('2026-10-05'), dueTime: '15:00' })] } });
    h.mail.script.push('throw');
    await runEmailReminders({
      now: () => new Date(NOW),
      users: async function* () { yield user(A); },
      tasksFor: async () => h.world.tasks[A],
      ledger: createEmailLedger(h.model),
      email: h.mail.service,
      dailyCap: 20,
      budgetMs: 60_000,
      log: logger,
    });
    expect(lines.join('\n')).toContain('[EmailReminders] run done');
    for (const leak of ['Secret Plan', 'example.test', A]) expect(lines.join('\n')).not.toContain(leak);
  });
});

vi.setConfig({ testTimeout: 30_000 });
