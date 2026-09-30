/**
 * Process lifecycle helpers — startup failure handling and graceful
 * shutdown — extracted into standalone, dependency-injected functions so
 * they can be unit tested without spawning a real process or opening a
 * real HTTP/DB connection.
 */

export type Logger = (...args: unknown[]) => void;

export interface ExitWithFatalErrorDeps {
  logError?: Logger;
  exit?: (code: number) => void;
}

/**
 * Logs a fatal startup error clearly and exits the process with a
 * non-zero status code. Used for startup-specific failures (distinct
 * from the generic uncaughtException/unhandledRejection handlers) so the
 * log message can say exactly what failed (e.g. "Failed to start
 * server") rather than a generic crash message.
 */
export function exitWithFatalError(
  message: string,
  error?: unknown,
  deps: ExitWithFatalErrorDeps = {},
): void {
  const logError = deps.logError ?? console.error;
  const exit = deps.exit ?? process.exit;

  if (error !== undefined) {
    logError(`[Server] ${message}:`, error);
  } else {
    logError(`[Server] ${message}`);
  }

  exit(1);
}

export interface GracefulShutdownDeps {
  /** Closes the HTTP server; resolves/invokes its callback once fully closed. */
  closeServer: (callback: (error?: Error) => void) => void;
  /** Closes the database connection. */
  closeDb: () => Promise<void>;
  log?: Logger;
  logError?: Logger;
  exit?: (code: number) => void;
  /** Milliseconds to wait before force-exiting if shutdown hangs. Default 10s. */
  forceExitMs?: number;
  /** Timer scheduler, injectable so tests don't need real timers. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

/**
 * Builds a `shutdown(signal)` handler that:
 *   1. Stops accepting new connections and waits for in-flight requests
 *      to finish (via closeServer's callback semantics).
 *   2. Closes the database connection.
 *   3. Exits cleanly (code 0).
 *
 * A force-exit timer runs in parallel as a safety net in case closing
 * takes too long; it's unref'd so it never keeps the event loop alive
 * on its own, and is cleared as soon as shutdown completes normally so
 * it never fires twice or after a clean exit.
 */
export function createGracefulShutdown(deps: GracefulShutdownDeps) {
  const {
    closeServer,
    closeDb,
    log = console.log,
    logError = console.error,
    exit = process.exit,
    forceExitMs = 10_000,
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
  } = deps;

  let shuttingDown = false;

  return async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      // A second signal while already shutting down — don't double-run
      // the sequence or schedule a second force-exit timer.
      return;
    }
    shuttingDown = true;

    log(`[Server] ${signal} received — shutting down gracefully`);

    const forceExit = setTimeoutFn(() => {
      logError('[Server] Graceful shutdown timed out — forcing exit');
      exit(1);
    }, forceExitMs);
    // Don't let this timer alone keep the process alive.
    forceExit.unref?.();

    await new Promise<void>((resolve) => {
      closeServer(async (error) => {
        if (error) {
          logError('[Server] Error closing HTTP server:', error);
        } else {
          log('[Server] HTTP server closed');
        }

        try {
          await closeDb();
          log('[Server] MongoDB connection closed');
        } catch (dbError) {
          logError('[Server] Error closing MongoDB connection:', dbError);
        }

        clearTimeoutFn(forceExit);
        exit(0);
        resolve();
      });
    });
  };
}
