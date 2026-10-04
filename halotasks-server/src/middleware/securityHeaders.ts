import type { NextFunction, Request, Response } from 'express';

// Baseline browser-hardening headers for the API (Issue #28). Deliberately small and explicit rather than
// a generic Helmet configuration; the reasoning for each choice (and each omission) is in docs/context.md
// "API Security Headers". Express-only: the client is served by Vercel and its headers are a separate concern.

/**
 * The API returns JSON, an empty 204 and one tiny `text/html` string (`GET /`). It renders nothing and
 * loads nothing, so the policy is "nothing may load or embed this" — inert for JSON/fetch, and a real
 * restriction only on that one HTML response. It is NOT a script/style policy: the pages that run script
 * are served by the client's host, which this header cannot reach.
 */
export const CONTENT_SECURITY_POLICY =
  "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";

/**
 * 180 days. Production only; no includeSubDomains / preload (the API lives on a shared platform domain,
 * and both are hard to undo). Not gated on req.secure: TLS is terminated upstream and `req.secure`
 * depends on TRUST_PROXY_HOPS, so it cannot be trusted to say "this is HTTPS".
 */
export const STRICT_TRANSPORT_SECURITY = 'max-age=15552000';

/**
 * Sets the headers on every response. Mount it FIRST — before cors() — so that responses `cors` ends
 * itself (the preflight 204) and every error response (404/400/401/413/429/500) carry them too.
 * It touches no other header and never ends the request, so CORS, caching (ETag/304) and bodies are unchanged.
 * `env` is read once, when the middleware is created.
 */
export const securityHeaders = (env: NodeJS.ProcessEnv = process.env) => {
  const production = env.NODE_ENV === 'production';

  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
    res.setHeader('X-Frame-Options', 'DENY');

    if (production) {
      res.setHeader('Strict-Transport-Security', STRICT_TRANSPORT_SECURITY);
    }

    next();
  };
};
