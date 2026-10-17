/**
 * Resolution and validation of the API base URL (the VITE_API_BASE_URL setting).
 *
 * Vite replaces `import.meta.env.VITE_*` with literal values while it BUILDS the bundle, so a missing
 * value in a production build cannot be noticed by the browser later: it is simply `undefined` there, and a
 * silent `?? 'http://localhost:5000'` fallback ships a bundle that talks to the visitor's own machine.
 * This module is therefore pure and shared by two callers, which pass the raw value in:
 *   - vite.config.ts checks it during `vite build`, so a bad configuration fails the build (the primary guard);
 *   - services/api.ts checks it when the client module loads (a backstop for the same rule).
 *
 * The value is a PUBLIC origin that ends up in the bundle. It is never a secret, and the errors below never
 * repeat the rejected value, so a mistakenly pasted secret or credential is not echoed into build logs or the
 * browser console.
 */

/** Local development default. Used only when the variable is absent and the build is not a production one. */
export const DEV_API_BASE_URL = 'http://localhost:5000';

export class ApiBaseUrlError extends Error {
  readonly code = 'INVALID_API_BASE_URL';

  constructor(reason: string) {
    super(`VITE_API_BASE_URL ${reason}`);
    this.name = 'ApiBaseUrlError';
  }
}

export type ApiBaseUrlInput = {
  /** The raw configured value, exactly as Vite exposes it (undefined when the variable is not set). */
  value: string | undefined;
  /** True for a production build or bundle, where the localhost default must never apply. */
  isProduction: boolean;
};

const MISSING_IN_PRODUCTION =
  'is required for production builds but is not set. Set it to the public origin of the API ' +
  '(for example https://api.example.com) in the environment that builds the client ' +
  '(on Vercel: Project Settings > Environment Variables) and build again.';

/**
 * Returns the API origin to use, or throws an ApiBaseUrlError.
 *
 * - Not set (or blank): the localhost default in development, an error in production.
 * - Set: must be an absolute http:// or https:// URL that is an origin only. This is checked in every mode,
 *   so a typo fails loudly in development as well instead of producing confusing request errors.
 * The returned value is the normalised origin (scheme, host and optional port; no trailing slash).
 */
export const resolveApiBaseUrl = ({ value, isProduction }: ApiBaseUrlInput): string => {
  const raw = typeof value === 'string' ? value.trim() : '';

  if (raw === '') {
    if (isProduction) throw new ApiBaseUrlError(MISSING_IN_PRODUCTION);
    return DEV_API_BASE_URL;
  }

  if (!/^https?:\/\//i.test(raw)) {
    throw new ApiBaseUrlError(
      'must be an absolute URL that starts with http:// or https:// ' +
        '(relative paths, bare hostnames and other protocols are not supported).',
    );
  }

  // `new URL` is lenient about slashes ('http:///x' parses with host 'x'), so require a host character explicitly.
  if (!/^https?:\/\/[^\s/\\?#]/i.test(raw)) {
    throw new ApiBaseUrlError('must include a host after the protocol.');
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiBaseUrlError('is not a valid URL (check the host and port).');
  }

  if (url.username !== '' || url.password !== '') {
    throw new ApiBaseUrlError(
      'must not contain a username or password: it is public and ends up in the client bundle.',
    );
  }

  if (url.pathname !== '/' || raw.includes('?') || raw.includes('#')) {
    throw new ApiBaseUrlError(
      'must be an origin only (protocol, host and optional port), with no path, query string or fragment. ' +
        'The client adds paths such as /api/tasks itself.',
    );
  }

  return url.origin;
};
