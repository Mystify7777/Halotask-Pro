import cors from 'cors';
import express from 'express';
import authRoutes from './routes/auth.routes';
import taskRoutes from './routes/task.routes';
import treeRoutes from './routes/tree.routes';

// ── CORS origin resolution ─────────────────────────────────────────────────────────────
// Fails CLOSED in production when CLIENT_ORIGIN is not set — no env var means
// no cross-origin access rather than open-to-all-origins.
// In development, falls back to common local dev ports so the app still works
// without an .env file.
const resolveOrigin = (): cors.CorsOptions['origin'] => {
  const clientOrigin = process.env.CLIENT_ORIGIN;

  if (clientOrigin) return clientOrigin;

  if (process.env.NODE_ENV !== 'production') {
    console.warn(
      '[CORS] CLIENT_ORIGIN not set — allowing localhost in development. ' +
      'Set CLIENT_ORIGIN in .env for predictable behaviour.',
    );
    return ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'];
  }

  // Production: missing env var → reject all cross-origin requests
  console.error(
    '[CORS] CLIENT_ORIGIN is not set in production. ' +
    'All cross-origin requests will be rejected.',
  );
  return false;
};

const app = express();

app.use(cors({ origin: resolveOrigin(), credentials: true }));

// Limit JSON body size to prevent large-payload memory exhaustion attacks
app.use(express.json({ limit: '1mb' }));

// ── Routes ──────────────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.send('HaloTasks API running');
});

app.use('/api/auth',  authRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/tree',  treeRoutes);

// ── 404 handler ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.originalUrl} not found` });
});

// ── Global error handler ───────────────────────────────────────────────────────────────────────
// In production: log the full error internally, return a generic message to
// the client — raw error.message can leak DB details, file paths, etc.
// In development: surface the message for easier debugging.
app.use(
  (
    error: unknown,
    _req: express.Request,
    res: express.Response,
    _next: express.NextFunction,
  ) => {
    const isDev = process.env.NODE_ENV !== 'production';
    console.error('[Server] Unhandled error:', error);
    const message =
      isDev && error instanceof Error ? error.message : 'Internal server error';
    res.status(500).json({ message });
  },
);

export default app;
