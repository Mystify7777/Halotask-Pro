import 'dotenv/config';
import mongoose from 'mongoose';
import app from './app';
import { connectDB } from './config/db';

// ── Startup validation ─────────────────────────────────────────────────────
// Fail fast on missing critical env vars — better to refuse to start than to
// run and silently return 500s on every authenticated request.
const REQUIRED_ENV = ['JWT_SECRET', 'MONGO_URI'] as const;
const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error(`[Server] Missing required environment variables: ${missing.join(', ')}`);
  process.exit(1);
}

const port = Number(process.env.PORT ?? 5000);

// ── Global crash handlers ──────────────────────────────────────────────────
// Must be registered before startServer() so they cover the DB connect phase.
process.on('uncaughtException', (error: Error) => {
  console.error('[Server] Uncaught exception — shutting down:', error);
  process.exit(1);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[Server] Unhandled promise rejection — shutting down:', reason);
  process.exit(1);
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
  const shutdown = async (signal: string) => {
    console.log(`[Server] ${signal} received — shutting down gracefully`);

    // Force-exit if shutdown takes longer than 10 seconds
    const forceExit = setTimeout(() => {
      console.error('[Server] Graceful shutdown timed out — forcing exit');
      process.exit(1);
    }, 10_000);
    forceExit.unref(); // don't keep the event loop alive just for this timer

    server.close(async () => {
      console.log('[Server] HTTP server closed');
      try {
        await mongoose.connection.close();
        console.log('[Server] MongoDB connection closed');
      } catch (err) {
        console.error('[Server] Error closing MongoDB connection:', err);
      }
      clearTimeout(forceExit);
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));
};

void startServer();
