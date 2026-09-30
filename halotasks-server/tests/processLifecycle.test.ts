import { describe, expect, it, vi } from 'vitest';
import { createGracefulShutdown, exitWithFatalError } from '../src/utils/processLifecycle';

describe('exitWithFatalError', () => {
  it('logs the message and error, then exits with code 1', () => {
    const logError = vi.fn();
    const exit = vi.fn();
    const error = new Error('boom');

    exitWithFatalError('Failed to start server', error, { logError, exit });

    expect(logError).toHaveBeenCalledWith('[Server] Failed to start server:', error);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('logs just the message when no error is given', () => {
    const logError = vi.fn();
    const exit = vi.fn();

    exitWithFatalError('Missing required environment variables: JWT_SECRET', undefined, {
      logError,
      exit,
    });

    expect(logError).toHaveBeenCalledWith(
      '[Server] Missing required environment variables: JWT_SECRET',
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('falls back to console.error and process.exit when no deps are supplied', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((() => undefined) as unknown) as never);

    exitWithFatalError('fatal');

    expect(consoleSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe('createGracefulShutdown', () => {
  const makeDeps = () => {
    const closeServer = vi.fn((callback: (error?: Error) => void) => callback());
    const closeDb = vi.fn(() => Promise.resolve());
    const log = vi.fn();
    const logError = vi.fn();
    const exit = vi.fn();
    return {
      closeServer,
      closeDb,
      log,
      logError,
      exit,
    };
  };

  it('closes the HTTP server before closing the database', async () => {
    const deps = makeDeps();
    const callOrder: string[] = [];
    deps.closeServer.mockImplementation((callback: (error?: Error) => void) => {
      callOrder.push('server');
      callback();
    });
    deps.closeDb.mockImplementation(async () => {
      callOrder.push('db');
    });

    const shutdown = createGracefulShutdown(deps);
    await shutdown('SIGTERM');

    expect(callOrder).toEqual(['server', 'db']);
  });

  it('exits with code 0 after both resources close successfully', async () => {
    const deps = makeDeps();
    const shutdown = createGracefulShutdown(deps);

    await shutdown('SIGTERM');

    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('still closes the database and exits 0 even if closing the HTTP server reports an error', async () => {
    const deps = makeDeps();
    deps.closeServer.mockImplementation((callback: (error?: Error) => void) =>
      callback(new Error('server close failed')),
    );

    const shutdown = createGracefulShutdown(deps);
    await shutdown('SIGTERM');

    expect(deps.closeDb).toHaveBeenCalled();
    expect(deps.logError).toHaveBeenCalledWith(
      '[Server] Error closing HTTP server:',
      expect.any(Error),
    );
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('still exits 0 even if closing the database throws', async () => {
    const deps = makeDeps();
    deps.closeDb.mockRejectedValue(new Error('db close failed'));

    const shutdown = createGracefulShutdown(deps);
    await shutdown('SIGTERM');

    expect(deps.logError).toHaveBeenCalledWith(
      '[Server] Error closing MongoDB connection:',
      expect.any(Error),
    );
    expect(deps.exit).toHaveBeenCalledWith(0);
  });

  it('force-exits with code 1 if shutdown does not complete before the timeout', () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      // closeServer never calls its callback — simulates a hang.
      deps.closeServer.mockImplementation(() => {});

      const shutdown = createGracefulShutdown({ ...deps, forceExitMs: 5000 });
      void shutdown('SIGTERM');

      expect(deps.exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(5000);

      expect(deps.logError).toHaveBeenCalledWith(
        '[Server] Graceful shutdown timed out — forcing exit',
      );
      expect(deps.exit).toHaveBeenCalledWith(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the force-exit timer on clean shutdown so it never fires afterward', async () => {
    vi.useFakeTimers();
    try {
      const deps = makeDeps();
      const shutdown = createGracefulShutdown({ ...deps, forceExitMs: 5000 });

      await shutdown('SIGTERM');
      expect(deps.exit).toHaveBeenCalledTimes(1);
      expect(deps.exit).toHaveBeenCalledWith(0);

      vi.advanceTimersByTime(10_000);

      // No second exit call from a stale force-exit timer.
      expect(deps.exit).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a second shutdown signal received while already shutting down', async () => {
    let resolveClose: (() => void) | undefined;
    const closeServer = vi.fn((callback: (error?: Error) => void) => {
      resolveClose = () => callback();
    });
    const closeDb = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();

    const shutdown = createGracefulShutdown({ closeServer, closeDb, exit });

    const firstCall = shutdown('SIGTERM');
    const secondCall = shutdown('SIGINT');

    resolveClose?.();
    await Promise.all([firstCall, secondCall]);

    expect(closeServer).toHaveBeenCalledTimes(1);
  });
});
