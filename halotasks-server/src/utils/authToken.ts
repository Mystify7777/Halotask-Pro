// The shape of a session JWT, checked at runtime (Issue #21). `jwt.verify()` proves the signature and expiry
// of a token, not what its payload looks like: it returns `string | JwtPayload`, and the claims inside are
// whatever was signed. A TypeScript cast over that result is not a check, so the claims the server relies on
// are validated here before anything uses them.

/** The one signing algorithm. Used by BOTH signing and verification so they cannot drift apart. */
export const JWT_ALGORITHM = 'HS256' as const;

export type TokenClaims = {
  userId: string;
  email: string;
  name: string;
  /** Session generation (Issue #27). A token with no `tv` claim predates it and counts as generation 0. */
  tokenVersion: number;
};

/**
 * Returns the claims of a verified token payload, or null if it is not shaped like one of ours:
 *   - the payload is a plain object (a token whose payload is a bare string or an array is rejected);
 *   - `userId` is a non-empty string, `email` and `name` are strings;
 *   - `tv` is absent (=> 0) or a non-negative integer — `null`, strings and fractions are rejected.
 * Extra claims (`iat`, `exp`, anything else) are ignored.
 */
export function parseTokenPayload(decoded: unknown): TokenClaims | null {
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    return null;
  }

  const { userId, email, name, tv } = decoded as Record<string, unknown>;

  if (typeof userId !== 'string' || userId === '' || typeof email !== 'string' || typeof name !== 'string') {
    return null;
  }

  const tokenVersion = tv === undefined ? 0 : tv;
  if (typeof tokenVersion !== 'number' || !Number.isInteger(tokenVersion) || tokenVersion < 0) {
    return null;
  }

  return { userId, email, name, tokenVersion };
}
