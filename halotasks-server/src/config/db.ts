import mongoose from 'mongoose';
import dns from 'node:dns';
import { getMongoConfig } from './env';

// ── MongoDB connection (Issue #20) ───────────────────────────────────────────────────────────────
//
// WHY THE DNS FALLBACK EXISTS — do not "simplify" it away. On some hosts the platform's own resolver
// refuses SRV queries (`querySrv ECONNREFUSED`), so a `mongodb+srv://` Atlas URI can never be resolved
// and the app cannot start, although the same URI works through a public resolver. The fix that
// shipped to production is: on exactly that error, retry ONCE with public resolvers.
//
// WHY IT IS FENCED IN. `dns.setServers()` changes the resolver for the WHOLE Node process (every
// `dns.resolve*` caller — the driver's SRV/TXT lookup, but also anything else — not just this connection).
// So the override is:
//   - applied only for the single fallback attempt, and ALWAYS restored in `finally`, whether that attempt
//     succeeds, fails or throws (and a failure to restore is logged loudly, never swallowed silently);
//   - never nested or overlapped: concurrent connectDB() calls share ONE attempt (below). Without that, a
//     second caller would capture the FALLBACK servers as "the originals" and could leave them installed
//     for good;
//   - confined to startup: server.ts awaits connectDB() BEFORE app.listen(), so no request handler is
//     running to be affected during the window (at most MONGO_SERVER_SELECTION_TIMEOUT_MS).
// Established connections use getaddrinfo (dns.lookup), which setServers() does not affect.

type LogFn = (message: string) => void;

export type ConnectDeps = {
  env?: NodeJS.ProcessEnv;
  connect?: (uri: string, options: { serverSelectionTimeoutMS: number }) => Promise<unknown>;
  getReadyState?: () => number;
  getDnsServers?: () => string[];
  setDnsServers?: (servers: string[]) => void;
  log?: { info: LogFn; warn: LogFn; error: LogFn };
};

const READY_STATE_CONNECTED = 1;

const isSrvDnsRefusal = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const withCode = error as Error & { code?: string; syscall?: string };
  return withCode.code === 'ECONNREFUSED' && withCode.syscall === 'querySrv';
};

/** Error name and code only. Messages can name hosts, and nothing here should ever risk the URI. */
const describeError = (error: unknown): string => {
  if (!(error instanceof Error)) return 'unknown error';
  const code = (error as Error & { code?: string | number }).code;
  return code === undefined ? error.name : `${error.name}/${code}`;
};

let inFlight: Promise<void> | null = null;

/** Clears the shared in-flight attempt (tests only). */
export const resetConnectDBStateForTests = (): void => {
  inFlight = null;
};

/**
 * Connects Mongoose, with the one-shot SRV DNS fallback described above.
 *
 *  - Configuration is validated first (config/env.ts getMongoConfig): a bad setting throws before any
 *    DNS or network work.
 *  - Already connected → returns immediately. A call made while another is in progress joins it instead of
 *    starting a second attempt; once an attempt settles, the next call starts a fresh one.
 *  - Never logs the connection string, its host, user or password: only the path taken (SRV, direct,
 *    SRV via fallback DNS), the timeout, and an error's name/code.
 */
export const connectDB = (deps: ConnectDeps = {}): Promise<void> => {
  const getReadyState = deps.getReadyState ?? (() => mongoose.connection.readyState);

  if (getReadyState() === READY_STATE_CONNECTED) {
    return Promise.resolve();
  }

  if (inFlight) {
    return inFlight;
  }

  const attempt = establishConnection(deps).finally(() => {
    if (inFlight === attempt) inFlight = null;
  });
  inFlight = attempt;
  return attempt;
};

async function establishConnection(deps: ConnectDeps): Promise<void> {
  const config = getMongoConfig(deps.env ?? process.env);
  const connect =
    deps.connect ?? ((uri: string, options: { serverSelectionTimeoutMS: number }) => mongoose.connect(uri, options));
  const getReadyState = deps.getReadyState ?? (() => mongoose.connection.readyState);
  const getDnsServers = deps.getDnsServers ?? (() => dns.getServers());
  const setDnsServers = deps.setDnsServers ?? ((servers: string[]) => dns.setServers(servers));
  const log = deps.log ?? {
    info: (message: string) => console.log(message),
    warn: (message: string) => console.warn(message),
    error: (message: string) => console.error(message),
  };

  const options = { serverSelectionTimeoutMS: config.serverSelectionTimeoutMS };

  // connect() has been seen to settle without a usable connection when it overlaps another attempt, so
  // success is confirmed from the connection state rather than assumed from the promise.
  const connectAndVerify = async () => {
    await connect(config.uri, options);
    if (getReadyState() !== READY_STATE_CONNECTED) {
      throw new Error('MongoDB connect() returned but the connection is not ready');
    }
  };

  log.info(
    `[DB] Connecting to MongoDB (${config.srv ? 'SRV' : 'direct'} connection string, ` +
      `server selection timeout ${config.serverSelectionTimeoutMS}ms)`,
  );

  try {
    await connectAndVerify();
    log.info(`[DB] MongoDB connected (${config.srv ? 'SRV' : 'direct'})`);
    return;
  } catch (error) {
    if (!config.srv || !isSrvDnsRefusal(error) || config.dnsFallbackServers.length === 0) {
      throw error;
    }
  }

  const fallbackServers = config.dnsFallbackServers;
  const previousServers = getDnsServers();
  log.warn(
    '[DB] SRV DNS lookup was refused (querySrv ECONNREFUSED). Retrying once with fallback DNS servers: ' +
      `${fallbackServers.join(', ')}. This overrides the process-wide DNS servers for this attempt only; ` +
      'they are restored afterwards.',
  );

  try {
    setDnsServers(fallbackServers);
    await connectAndVerify();
    log.info('[DB] MongoDB connected (SRV, via fallback DNS servers)');
  } catch (error) {
    log.error(`[DB] Fallback DNS attempt failed (${describeError(error)}); original DNS servers restored.`);
    throw error;
  } finally {
    // Restore the original servers whether the retry succeeded, failed or threw. This prevents the
    // fallback resolvers leaking into everything else in the process (email, push, API calls...).
    try {
      setDnsServers(previousServers);
    } catch (restoreError) {
      log.error(
        `[DB] CRITICAL: could not restore the original DNS servers (${describeError(restoreError)}). ` +
          'The process may still be using the fallback DNS servers.',
      );
    }
  }
}
