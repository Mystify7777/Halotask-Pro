/**
 * IANA time zone preference (Issue #41).
 *
 * The stored value is an IANA zone identifier ("Asia/Kolkata", "America/Los_Angeles", "UTC"), never a fixed UTC
 * offset: an offset cannot express a zone's daylight-saving rules, past or future. The runtime's own time zone
 * data (ICU, through Intl) is the only authority; there is no hand-kept list here.
 *
 * Node's Intl happily accepts "+05:30" or "-08:00" as a `timeZone`, so acceptance by Intl alone is not enough: the
 * shape must also look like an IANA identifier (letters first, no sign or colon), which is what excludes offsets.
 */

export const TIME_ZONE_MAX_LENGTH = 64;

// "Area/Location[/Sub]", or a single legacy/identifier word ("UTC", "GMT", "EST5EDT"). It must start with a letter,
// so "+05:30" and "-08:00" never match; "Etc/GMT+5" (a real identifier) still does.
const IANA_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

export const TIME_ZONE_INVALID_MESSAGE = 'timeZone must be a valid IANA time zone identifier, for example "Asia/Kolkata"';

/** True only for a string that is an IANA identifier this runtime knows. Never throws. */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > TIME_ZONE_MAX_LENGTH) return false;
  if (!IANA_SHAPE.test(value)) return false;

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type TimeZoneInput = { ok: true; value: string | null } | { ok: false; message: string };

/**
 * The `timeZone` field of a preferences request: a valid identifier sets the preference, `null` clears it (the
 * client then falls back to the device's zone). Anything else, including a missing field, an empty string, an offset
 * or a non-string, is rejected rather than normalised.
 */
export function parseTimeZoneInput(raw: unknown): TimeZoneInput {
  if (raw === null) return { ok: true, value: null };
  if (isValidTimeZone(raw)) return { ok: true, value: raw };
  return { ok: false, message: TIME_ZONE_INVALID_MESSAGE };
}
