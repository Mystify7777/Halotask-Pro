import nodemailer from 'nodemailer';

/**
 * Shared email delivery (Issue #29). It delivers one message, falls back between providers, and reports what it can
 * and cannot know. It never decides WHEN a message is sent: password reset and the reminder run both call it.
 *
 *   SMTP (primary, when all four SMTP_* variables are set)  ->  Brevo (fallback, when BREVO_API_KEY is set)
 *
 * DELIVERY SEMANTICS (what is and is not guaranteed). Email has no exactly-once API: when a connection drops or times
 * out after the message was handed over, the provider may or may not have accepted it, and nothing this service can ask
 * will tell. So every provider failure is classified as
 *   - definite:  the provider provably did NOT accept the message (could not connect, refused the login, rejected the
 *                sender or recipient, answered the message with a 4xx/5xx reply, or answered an HTTP 4xx), or
 *   - ambiguous: it MAY have accepted it (a timeout or a dropped socket after the message was sent, an HTTP 5xx or a
 *                timeout from Brevo's API, which may have queued it, anything unrecognised, a thrown non-Error).
 * and the caller picks a fallback policy:
 *   - 'definite-only' (reminders): fall back to the next provider only after a DEFINITE failure. An ambiguous failure
 *                stops the send with status 'unknown' and nothing is sent twice. Cost: an occasional reminder is lost
 *                instead of duplicated.
 *   - 'any-failure' (password reset, the behaviour that has always applied): any failure falls through to the next
 *                provider, so a duplicate is possible and a lost message is not. A reset code is safe to receive twice
 *                (the newest replaces the old) and the user can ask again.
 *
 * Credentials are read from the environment at call time, are never returned and never logged. Provider error TEXT is
 * never logged or returned at all (it can echo a username, an address or a response body): only a short code
 * (for example `smtp:EAUTH` or `brevo:HTTP_400`) and the masked recipient reach a log line.
 */

export type EmailMessage = { to: string; subject: string; text: string; html?: string };
export type ProviderName = 'smtp' | 'brevo';
export type FallbackPolicy = 'any-failure' | 'definite-only';

/** What one provider reports. `definite` only matters when `accepted` is false. */
export type ProviderResult =
  | { accepted: true }
  | { accepted: false; definite: boolean; code: string };

export type EmailProvider = {
  name: ProviderName;
  send: (message: EmailMessage, from: string) => Promise<ProviderResult>;
};

export type SendResult =
  | { status: 'sent'; provider: ProviderName }
  /** Every configured provider definitely did not accept the message. Safe to retry later. */
  | { status: 'failed'; codes: string[] }
  /** A provider may have accepted the message. NOT safe to retry: a retry could duplicate it. */
  | { status: 'unknown'; codes: string[] }
  /** No provider is configured. */
  | { status: 'unconfigured' };

export type EmailLogger = Pick<Console, 'info' | 'warn' | 'error'>;

export const maskEmail = (email: string): string => {
  const [local, domain] = email.split('@');

  if (!local || !domain) {
    return '[invalid-email]';
  }

  if (local.length <= 2) {
    return `**@${domain}`;
  }

  return `${local.slice(0, 2)}***@${domain}`;
};

// ── Classification ──────────────────────────────────────────────────────────────────────────────────────────────

// nodemailer sets `command` to the SMTP step that failed. Everything up to and including RCPT TO happens BEFORE the
// message body is sent, so a failure there proves nothing was accepted.
const PRE_DATA_COMMANDS = new Set(['CONN', 'EHLO', 'HELO', 'STARTTLS', 'AUTH', 'AUTH PLAIN', 'AUTH LOGIN', 'AUTH XOAUTH2', 'MAIL FROM', 'RCPT TO']);
const DEFINITE_CODES = new Set(['EAUTH', 'EENVELOPE', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONFIG']);

type SmtpErrorShape = { code?: unknown; command?: unknown; responseCode?: unknown };

/** Whether an SMTP failure proves the message was not accepted. Exported for tests. Unknown shapes are ambiguous. */
export const classifySmtpError = (error: unknown): { definite: boolean; code: string } => {
  const e = (typeof error === 'object' && error !== null ? error : {}) as SmtpErrorShape;
  const code = typeof e.code === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(e.code) ? e.code : 'SMTP_ERROR';
  const command = typeof e.command === 'string' ? e.command : '';
  const responseCode = typeof e.responseCode === 'number' ? e.responseCode : null;

  // The server answered with a failure (4xx/5xx), including a refusal of the finished message: it did not accept it.
  if (responseCode !== null && responseCode >= 400 && responseCode <= 599) return { definite: true, code };
  if (DEFINITE_CODES.has(code)) return { definite: true, code };
  if (PRE_DATA_COMMANDS.has(command)) return { definite: true, code };
  return { definite: false, code };
};

/**
 * Brevo's HTTP API (POST /v3/smtp/email): an HTTP 4xx (bad key, rejected sender, validation, rate limit) proves no
 * message was created. A 5xx, a timeout or a dropped connection after the request left may or may not have queued it, so
 * those are ambiguous. A failure to even reach the host (refused, DNS) is definite. Exported for tests.
 */
export const classifyBrevoFailure = (failure: { status?: number | null; error?: unknown }): { definite: boolean; code: string } => {
  const { status, error } = failure;
  if (typeof status === 'number') {
    if (status >= 400 && status <= 499) return { definite: true, code: `HTTP_${status}` };
    return { definite: false, code: `HTTP_${status}` };
  }
  const cause = (typeof error === 'object' && error !== null ? (error as { cause?: unknown }).cause : undefined) as { code?: unknown } | undefined;
  if (typeof cause?.code === 'string' && DEFINITE_CODES.has(cause.code)) return { definite: true, code: cause.code };
  const name = typeof error === 'object' && error !== null ? (error as { name?: unknown }).name : undefined;
  return { definite: false, code: name === 'TimeoutError' || name === 'AbortError' ? 'BREVO_TIMEOUT' : 'BREVO_ERROR' };
};

// ── Providers ───────────────────────────────────────────────────────────────────────────────────────────────────

type SmtpTransport = Pick<ReturnType<typeof nodemailer.createTransport>, 'sendMail'>;

export const createSmtpProvider = (transporter: SmtpTransport): EmailProvider => ({
  name: 'smtp',
  send: async (message, from) => {
    try {
      const info = await transporter.sendMail({ from, to: message.to, subject: message.subject, text: message.text, html: message.html });
      if (info.messageId) return { accepted: true };
      // Resolved without a message id: not something nodemailer does on a real acceptance, and not provably a refusal.
      return { accepted: false, definite: false, code: 'SMTP_NO_MESSAGE_ID' };
    } catch (error) {
      return { accepted: false, ...classifySmtpError(error) };
    }
  },
});

export const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';
export const BREVO_TIMEOUT_MS = 15_000;

/** "Name <a@b.test>" or "a@b.test" as Brevo's sender object; null when it is neither. */
export const parseSender = (from: string): { email: string; name?: string } | null => {
  const named = /^\s*"?([^"<>]*?)"?\s*<([^<>\s@]+@[^<>\s@]+)>\s*$/.exec(from);
  if (named) return named[1] ? { email: named[2], name: named[1] } : { email: named[2] };
  const bare = /^\s*([^<>\s@]+@[^<>\s@]+)\s*$/.exec(from);
  return bare ? { email: bare[1] } : null;
};

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  status: number;
  json: () => Promise<unknown>;
}>;

/**
 * Brevo's transactional API over plain HTTPS (no SDK, so no extra dependency). The API key travels only in the
 * `api-key` header of this one request and appears nowhere else. `htmlContent` is required by Brevo, so a text-only
 * message is sent with its text as the HTML body too.
 */
export const createBrevoProvider = (apiKey: string, fetchImpl: FetchLike = fetch as unknown as FetchLike): EmailProvider => ({
  name: 'brevo',
  send: async (message, from) => {
    const sender = parseSender(from);
    if (!sender) return { accepted: false, definite: true, code: 'BREVO_BAD_SENDER' }; // misconfiguration: nothing was sent

    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await fetchImpl(BREVO_ENDPOINT, {
        method: 'POST',
        headers: { 'api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender,
          to: [{ email: message.to }],
          subject: message.subject,
          textContent: message.text,
          htmlContent: message.html ?? `<p>${escapeHtml(message.text).replace(/\n/g, '<br>')}</p>`,
        }),
        signal: AbortSignal.timeout(BREVO_TIMEOUT_MS),
      });
    } catch (error) {
      return { accepted: false, ...classifyBrevoFailure({ error }) };
    }

    if (response.status === 201) {
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        // an unreadable 201 body is still a 201
      }
      const id = (body as { messageId?: unknown } | null)?.messageId;
      // 201 is Brevo's acceptance. A 201 with no id is not provably a failure, so it is not retried either way.
      return typeof id === 'string' && id.length > 0 ? { accepted: true } : { accepted: false, definite: false, code: 'BREVO_NO_ID' };
    }

    return { accepted: false, ...classifyBrevoFailure({ status: response.status }) };
  },
});

// ── Delivery ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Tries the providers in order under `policy`. Never throws: a provider that throws is an ambiguous failure.
 * `log` receives masked, credential-free lines only.
 */
export const deliver = async (
  providers: EmailProvider[],
  message: EmailMessage,
  from: string,
  policy: FallbackPolicy,
  log: EmailLogger = console,
): Promise<SendResult> => {
  if (providers.length === 0) return { status: 'unconfigured' };

  const codes: string[] = [];
  let ambiguous = false;

  for (const provider of providers) {
    let result: ProviderResult;
    try {
      result = await provider.send(message, from);
    } catch {
      result = { accepted: false, definite: false, code: 'PROVIDER_THREW' };
    }

    if (result.accepted) {
      log.info(`[Email] Delivered via ${provider.name}. Recipient: ${maskEmail(message.to)}`);
      return { status: 'sent', provider: provider.name };
    }

    codes.push(`${provider.name}:${result.code}`);
    log.error(
      `[Email] ${provider.name} ${result.definite ? 'did not accept' : 'MAY have accepted'} the message for ${maskEmail(message.to)} (${result.code}).`,
    );

    if (!result.definite) {
      ambiguous = true;
      if (policy === 'definite-only') return { status: 'unknown', codes };
    }
  }

  return ambiguous ? { status: 'unknown', codes } : { status: 'failed', codes };
};

// ── Environment-backed service ─────────────────────────────────────────────────────────────────────────────────────

export const DEFAULT_EMAIL_FROM = 'noreply@halotaskpro.com';

export type EmailService = {
  /** True when at least one provider is configured. */
  isConfigured: () => boolean;
  send: (message: EmailMessage, policy: FallbackPolicy) => Promise<SendResult>;
};

type Cached<T> = { key: string; value: T };

/**
 * The service every caller uses. Providers are built from the environment on each call (cached by configuration), so
 * a test or a deploy-time change needs no module reload, and no secret is held anywhere but process.env and the
 * provider clients themselves.
 */
export const createEnvEmailService = (log: EmailLogger = console): EmailService => {
  let smtp: Cached<EmailProvider> | null = null;
  let brevo: Cached<EmailProvider> | null = null;

  const providers = (): EmailProvider[] => {
    const list: EmailProvider[] = [];

    const host = process.env.SMTP_HOST;
    const port = process.env.SMTP_PORT;
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    if (host && port && user && pass) {
      const key = JSON.stringify([host, port, user, pass]);
      if (smtp?.key !== key) {
        smtp = {
          key,
          value: createSmtpProvider(
            nodemailer.createTransport({ host, port: Number(port), secure: port === '465', auth: { user, pass } }),
          ),
        };
      }
      list.push(smtp.value);
    } else {
      smtp = null;
    }

    const apiKey = process.env.BREVO_API_KEY;
    if (apiKey) {
      if (brevo?.key !== apiKey) brevo = { key: apiKey, value: createBrevoProvider(apiKey) };
      list.push(brevo.value);
    } else {
      brevo = null;
    }

    return list;
  };

  return {
    isConfigured: () => providers().length > 0,
    send: (message, policy) => deliver(providers(), message, process.env.EMAIL_FROM || DEFAULT_EMAIL_FROM, policy, log),
  };
};

let shared: EmailService | null = null;

/** The process-wide service. Tests replace it with `setEmailService`. */
export const getEmailService = (): EmailService => (shared ??= createEnvEmailService());

export const setEmailService = (service: EmailService | null): void => {
  shared = service;
};
