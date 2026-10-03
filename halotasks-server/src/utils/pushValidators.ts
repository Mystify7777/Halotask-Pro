import { isIP } from 'node:net';

// ── Push API input contract (Issue #26) ─────────────────────────────────────────
//
// Every limit below comes from the Web Push protocol or from what the client actually sends, not from
// a guess; the reasoning is next to each constant. All failures are 400 with a message that never
// echoes the submitted value (an endpoint is a capability URL and must not end up in responses or logs).

/**
 * A push endpoint is a URL on the browser vendor's push service. Real ones are 100-300 characters
 * (FCM, Mozilla autopush, WNS, Apple). 2048 is the de-facto URL ceiling and leaves ample headroom.
 */
export const PUSH_ENDPOINT_MAX_LENGTH = 2048;

/** RFC 8291: the user-agent public key is an uncompressed P-256 point = 65 octets (web-push enforces it too). */
export const PUSH_P256DH_BYTES = 65;

/** RFC 8291: the authentication secret is exactly 16 octets (web-push accepts >= 16; browsers send 16). */
export const PUSH_AUTH_BYTES = 16;

/**
 * Each stored subscription is one browser/device profile and costs one outbound request per relay.
 * Ten is generous for a personal task app. When an 11th is added the OLDEST is dropped (see the
 * controller), so a legitimate user whose old endpoints have gone stale can always register a new device.
 */
export const PUSH_SUBSCRIPTIONS_MAX_PER_USER = 10;

/** Latest value a JS Date (and so a browser's expirationTime, epoch ms) can hold. */
const MAX_EXPIRATION_TIME = 8_640_000_000_000_000;

/**
 * Relay text limits, derived from the client (reminders/notification.ts): the title is one of four fixed
 * phrases (<= 40 chars); the body is a short template wrapped around a task title, and task titles are
 * capped at TITLE_MAX_LENGTH = 200 (<= ~270 chars); the tag is `halotask-<type>-<taskId>-<due date>`
 * (~100 chars). The limits leave headroom without letting a caller send arbitrary amounts of text.
 */
export const PUSH_TITLE_MAX_LENGTH = 100;
export const PUSH_BODY_MAX_LENGTH = 500;
export const PUSH_TAG_MAX_LENGTH = 200;
export const PUSH_DEFAULT_TAG = 'halotask-push';

/**
 * RFC 8291 limits the plaintext of one push message to 3993 octets (4096 minus encryption overhead).
 * Character limits alone do not guarantee this (multi-byte text, JSON escaping), so the serialised
 * payload is checked in bytes as well.
 */
export const PUSH_PAYLOAD_MAX_BYTES = 3993;

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; message: string };

export type ValidSubscription = {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
};

export type ValidRelay = { title: string; body: string; tag: string; payload: string };

const fail = (message: string): { ok: false; message: string } => ({ ok: false, message });

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const CONTROL_OR_SPACE = /[\s\u0000-\u001f\u007f]/;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Canonical unpadded base64url that decodes to exactly `bytes` octets (rejects padding, '+', '/', stray bits). */
function isBase64UrlOfBytes(value: unknown, bytes: number): value is string {
  if (typeof value !== 'string' || !BASE64URL.test(value)) return false;
  const decoded = Buffer.from(value, 'base64url');
  return decoded.length === bytes && decoded.toString('base64url') === value;
}

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.localdomain', '.lan', '.home', '.corp'];

/**
 * The endpoint is untrusted input that the SERVER later POSTs to (relay). Shape checks, in order:
 * a string within the length limit; no whitespace/control characters; parses as a URL; https only
 * (RFC 8030 requires https for push services); no embedded credentials; default port only (push
 * services use 443); host is a DNS name — no IP literal in any spelling (the URL parser normalises
 * decimal/hex/octal IPv4 first, so those are caught too), no localhost, no single-label or obviously
 * internal names. A hostname that RESOLVES to a private address cannot be detected here — see the
 * documented limitation.
 */
function validateEndpoint(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string' || value.length === 0) {
    return fail('endpoint is required and must be a string.');
  }
  if (value.length > PUSH_ENDPOINT_MAX_LENGTH) {
    return fail(`endpoint must be at most ${PUSH_ENDPOINT_MAX_LENGTH} characters.`);
  }
  if (CONTROL_OR_SPACE.test(value)) {
    return fail('endpoint must not contain whitespace or control characters.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail('endpoint must be a valid URL.');
  }

  if (url.protocol !== 'https:') return fail('endpoint must be an https URL.');
  if (url.username !== '' || url.password !== '') return fail('endpoint must not contain credentials.');
  if (url.port !== '') return fail('endpoint must use the default https port.');

  const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host.length === 0 || isIP(host) !== 0) return fail('endpoint host must be a DNS name, not an IP address.');
  if (!host.includes('.') || host === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return fail('endpoint host is not an acceptable push service host.');
  }

  return { ok: true, value };
}

export function parsePushSubscription(body: unknown, now: number = Date.now()): ValidationResult<ValidSubscription> {
  if (!isPlainObject(body)) return fail('Request body must be a JSON object.');

  const endpoint = validateEndpoint(body.endpoint);
  if (!endpoint.ok) return endpoint;

  if (!isPlainObject(body.keys)) return fail('keys is required and must be an object.');
  const { p256dh, auth } = body.keys;
  if (!isBase64UrlOfBytes(p256dh, PUSH_P256DH_BYTES)) {
    return fail(`keys.p256dh must be unpadded base64url encoding of ${PUSH_P256DH_BYTES} bytes.`);
  }
  if (!isBase64UrlOfBytes(auth, PUSH_AUTH_BYTES)) {
    return fail(`keys.auth must be unpadded base64url encoding of ${PUSH_AUTH_BYTES} bytes.`);
  }

  let expirationTime: number | null = null;
  if (body.expirationTime !== undefined && body.expirationTime !== null) {
    const t = body.expirationTime;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < 0 || t > MAX_EXPIRATION_TIME) {
      return fail('expirationTime must be null or a non-negative integer number of milliseconds since the epoch.');
    }
    if (t <= now) return fail('expirationTime must be in the future.');
    expirationTime = t;
  }

  // Only the known fields are kept; anything else in the body is dropped, never stored.
  return { ok: true, value: { endpoint: endpoint.value, expirationTime, keys: { p256dh, auth } } };
}

/** Unsubscribe only needs to *identify* a stored endpoint, so it is checked for type and size, not URL shape
 *  (that also lets a legacy, no-longer-valid entry still be removed). Objects such as `{ $ne: 'x' }` are rejected. */
export function parseUnsubscribe(body: unknown): ValidationResult<{ endpoint: string }> {
  if (!isPlainObject(body)) return fail('Request body must be a JSON object.');
  const { endpoint } = body;
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    return fail('endpoint is required and must be a string.');
  }
  if (endpoint.length > PUSH_ENDPOINT_MAX_LENGTH) {
    return fail(`endpoint must be at most ${PUSH_ENDPOINT_MAX_LENGTH} characters.`);
  }
  return { ok: true, value: { endpoint } };
}

export function parseRelay(body: unknown): ValidationResult<ValidRelay> {
  if (!isPlainObject(body)) return fail('Request body must be a JSON object.');
  const { title, body: text, tag } = body;

  if (typeof title !== 'string' || title.trim().length === 0) return fail('title is required and must be a non-empty string.');
  if (title.length > PUSH_TITLE_MAX_LENGTH) return fail(`title must be at most ${PUSH_TITLE_MAX_LENGTH} characters.`);
  if (typeof text !== 'string' || text.trim().length === 0) return fail('body is required and must be a non-empty string.');
  if (text.length > PUSH_BODY_MAX_LENGTH) return fail(`body must be at most ${PUSH_BODY_MAX_LENGTH} characters.`);

  let resolvedTag = PUSH_DEFAULT_TAG;
  if (tag !== undefined && tag !== null) {
    if (typeof tag !== 'string' || tag.length === 0) return fail('tag must be a non-empty string when provided.');
    if (tag.length > PUSH_TAG_MAX_LENGTH) return fail(`tag must be at most ${PUSH_TAG_MAX_LENGTH} characters.`);
    if (CONTROL_CHARS.test(tag)) return fail('tag must not contain control characters.');
    resolvedTag = tag;
  }

  const payload = JSON.stringify({ title, body: text, tag: resolvedTag });
  if (Buffer.byteLength(payload, 'utf8') > PUSH_PAYLOAD_MAX_BYTES) {
    return fail(`notification is too large (at most ${PUSH_PAYLOAD_MAX_BYTES} bytes once serialised).`);
  }

  return { ok: true, value: { title, body: text, tag: resolvedTag, payload } };
}
