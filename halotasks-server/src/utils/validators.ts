// Single source of truth for auth input rules — used by registration, login,
// forgot-password, and reset-password so the rules can't silently drift
// between flows (e.g. reset-password enforcing a password minimum that
// registration forgot to).

export const PASSWORD_MIN_LENGTH = 6;
export const NAME_MAX_LENGTH = 100;

// Deliberately simple (not RFC 5322-complete) — this only needs to catch
// obviously malformed input; real deliverability is proven by actually
// sending the email.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
  return EMAIL_PATTERN.test(email);
}

export function normalizeName(name: string): string {
  // Collapse internal runs of whitespace in addition to trimming the ends,
  // so "  Aryan   K  " doesn't get stored with the extra spaces intact.
  return name.trim().replace(/\s+/g, ' ');
}

export function isValidName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX_LENGTH;
}

export function isValidPassword(password: string): boolean {
  return typeof password === 'string' && password.length >= PASSWORD_MIN_LENGTH;
}
