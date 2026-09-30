import type { CorsOptions } from 'cors';

/**
 * Resolves the CORS origin setting from environment configuration.
 *
 * Fails CLOSED in production when CLIENT_ORIGIN is not set — no env var
 * means no cross-origin access rather than open-to-all-origins. In
 * development, falls back to common local dev ports so the app still
 * works without an .env file.
 *
 * Extracted from app.ts so it can be unit tested in isolation without
 * spinning up the full Express app.
 */
export const resolveOrigin = (
  env: NodeJS.ProcessEnv = process.env,
  log: { warn: (msg: string) => void; error: (msg: string) => void } = console,
): CorsOptions['origin'] => {
  const clientOrigin = env.CLIENT_ORIGIN;

  if (clientOrigin) return clientOrigin;

  if (env.NODE_ENV !== 'production') {
    log.warn(
      '[CORS] CLIENT_ORIGIN not set — allowing localhost in development. ' +
        'Set CLIENT_ORIGIN in .env for predictable behaviour.',
    );
    return ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
  }

  // Production: missing env var → reject all cross-origin requests
  log.error(
    '[CORS] CLIENT_ORIGIN is not set in production. ' +
      'All cross-origin requests will be rejected.',
  );
  return false;
};
