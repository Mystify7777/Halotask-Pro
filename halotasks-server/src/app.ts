import cors from 'cors';
import express from 'express';
import aiRoutes from './routes/ai.routes';
import authRoutes from './routes/auth.routes';
import pushRoutes from './routes/push.routes';
import taskRoutes from './routes/task.routes';
import treeRoutes from './routes/tree.routes';
import historyRoutes from './routes/history.routes';
import { resolveOrigin } from './config/cors';
import { getTrustProxyHops } from './config/env';
import { securityHeaders } from './middleware/securityHeaders';
import { isMalformedJsonBodyError, isPayloadTooLargeError } from './utils/httpErrors';

const app = express();

// What req.ip means (and so every IP-keyed rate limit) depends on how many reverse proxies sit in
// front of this process. Explicit and conservative: 0 hops (forwarded headers ignored) unless
// TRUST_PROXY_HOPS says otherwise. See docs/context.md "Rate Limiting".
app.set('trust proxy', getTrustProxyHops());

// Don't advertise the framework (X-Powered-By: Express).
app.disable('x-powered-by');

// Security headers go FIRST, before cors(): cors() answers preflights itself without calling next(), so
// anything mounted after it would miss those responses. See docs/context.md "API Security Headers".
app.use(securityHeaders());

app.use(cors({ origin: resolveOrigin(), credentials: true }));

// Limit JSON body size to prevent large-payload memory exhaustion attacks
app.use(express.json({ limit: '1mb' }));

// ── Routes ──────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send('HaloTasks API running');
});

app.use('/api/auth',  authRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/push', pushRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/tree',  treeRoutes);
app.use('/api/history', historyRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// ── Global error handler ───────────────────────────────────────────────────────────────────────
// In production: log the full error internally, return a generic message to
// the client — raw error.message can leak DB details, file paths, etc.
// In development: surface the message for easier debugging.
//
// express.json() (body-parser) already determines the correct status for
// request-body problems — 413 for an oversized body, 400 for malformed
// JSON — but throws a regular Error, so without an explicit check here
// those would fall through to a misleading generic 500.
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    if (isPayloadTooLargeError(error)) {
      res.status(413).json({ message: 'Request body is too large' });
      return;
    }

    if (isMalformedJsonBodyError(error)) {
      res.status(400).json({ message: 'Request body is not valid JSON' });
      return;
    }

    const isDev = process.env.NODE_ENV !== 'production';
    console.error('[Server] Unhandled error:', error);
    const message =
      isDev && error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ message });
  },
);

export default app;
