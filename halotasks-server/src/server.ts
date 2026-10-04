import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app';
import { connectDB } from './config/db';
import { getGroqApiKey, getMongoConfig, getResetTokenTtlMinutes, getTrustProxyHops } from './config/env';
import { createGracefulShutdown, exitWithFatalError } from './utils/processLifecycle';

// ── Startup validation ─────────────────────────────────────────────────────
// Fail fast on missing critical env vars — better to refuse to start than to
// run and silently return 500s on every authenticated request.
const REQUIRED_ENV = ['JWT_SECRET', 'MONGO_URI'] as const;
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  exitWithFatalError(`Missing required environment variables: ${missing.join(', ')}`);
}

// A malformed RESET_TOKEN_TTL_MINUTES would otherwise silently produce
// reset tokens that expire immediately (or never) — fail fast instead.
try {
  getResetTokenTtlMinutes();
} catch (error) {
  exitWithFatalError('Invalid RESET_TOKEN_TTL_MINUTES configuration', error);
}

// A malformed MONGO_URI scheme, MONGO_DNS_SERVERS or MONGO_SERVER_SELECTION_TIMEOUT_MS is rejected here, before
// any DNS or network work (the message never contains MONGO_URI or its credentials).
try {
  getMongoConfig();
} catch (error) {
  exitWithFatalError('Invalid MongoDB configuration', error);
}

// AI task creation is optional: without GROQ_API_KEY the endpoint answers 503 and the rest of the app
// is unaffected, so warn (like missing VAPID keys) rather than refuse to start.
if (!getGroqApiKey()) {
  console.warn('[AI] GROQ_API_KEY not configured. AI task creation will be unavailable.');
}

// app.ts already refuses to load with a malformed TRUST_PROXY_HOPS (it would silently mis-key every IP
// rate limit). Here we only flag the misconfiguration that is valid but wrong behind a platform proxy.
if (getTrustProxyHops() === 0 && process.env.NODE_ENV === 'production') {
  console.warn(
    '[RateLimit] TRUST_PROXY_HOPS is 0 in production: behind a platform proxy every client shares the ' +
      "proxy's IP and therefore one IP rate-limit bucket. Set it to the number of proxy hops.",
  );
}

const port = Number(process.env.PORT ?? 5000);

// ── Global crash handlers ──────────────────────────────────────────────────
// Must be registered before startServer() so they cover the DB connect phase.
process.on('uncaughtException', (error: Error) => {
  exitWithFatalError('Uncaught exception — shutting down', error);
});

process.on('unhandledRejection', (reason: unknown) => {
  exitWithFatalError('Unhandled promise rejection — shutting down', reason);
});

// ── Start ──────────────────────────────────────────────────────────────────
const startServer = async () => {
  await connectDB();

  const server = app.listen(port, () => {
    console.log(`[Server] Running on port ${port} (${process.env.NODE_ENV ?? 'development'})`);
  });

  // ── Graceful shutdown ────────────────────────────────────────────────────
  // Stop accepting new connections, wait for in-flight requests to finish,
  // then close the MongoDB connection before exiting.
  const shutdown = createGracefulShutdown({
    closeServer: (callback) => server.close((error) => callback(error)),
    closeDb: () => mongoose.connection.close(),
  });

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
};

// Startup-specific failures (e.g. the DB connection failing) get a clear,
// specific log message here rather than falling through to the generic
// uncaughtException/unhandledRejection handlers above.
startServer().catch((error) => exitWithFatalError('Failed to start server', error));
