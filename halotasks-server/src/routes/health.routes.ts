import { Router } from 'express';
import mongoose from 'mongoose';

/** Mongoose's `connection.readyState` for "connected". */
const CONNECTED = 1;

/**
 * Backend readiness for clients that have no session yet (Issue #12): the login and register pages poll this while a
 * sleeping host (Render's free tier) wakes up, so the "server is ready" decision is a real answer from the running
 * process, not a guess.
 *
 *  - 200 `{ status: 'ok' }`          the process is serving and its database connection is up;
 *  - 503 `{ status: 'unavailable' }` the process is serving but its database is not connected.
 *
 * Limit: server.ts connects to MongoDB BEFORE it listens, so this is not served at all during startup and cannot report
 * startup progress. The 503 is for a process that is already serving whose connection has since dropped.
 *
 * The two bodies are what tells a client "the app answered and is unhealthy" apart from "nothing sensible answered
 * yet" (a host that is still waking returns no response, or a gateway error with its own body). Deliberately public
 * and deliberately tiny: no user, task, version, environment or error detail, and never cached.
 */
export function createHealthRouter(getReadyState: () => number = () => mongoose.connection.readyState): Router {
  const router = Router();

  router.get('/', (_req, res) => {
    const ready = getReadyState() === CONNECTED;
    res.set('Cache-Control', 'no-store');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable' });
  });

  return router;
}

export default createHealthRouter();
