import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useBackendReadiness, type ReadinessPacing } from '../hooks/useBackendReadiness';
import { useAuthStore } from '../store/authStore';
import { getTokenExpiryMs } from '../utils/authSession';
import { LaunchContext, type LaunchContextValue } from './launchContext';
import {
  classifySession,
  deriveLaunchState,
  recordVerdict,
  serverStatusFrom,
  sessionKeyOf,
  verdictFor,
  type ScopedVerdict,
} from './launchState';
import { backgroundProbeDelayMs, probeDelayMs } from './probeBackoff';
import { subscribeSessionAnswers } from './sessionAnswers';

/** Growing, jittered gaps while the server does not answer, then a slow background re-check instead of a dead end. */
const LAUNCH_PACING: ReadinessPacing = {
  nextDelayMs: (unanswered) => probeDelayMs(unanswered),
  backgroundDelayMs: () => backgroundProbeDelayMs(),
};

/** The largest delay setTimeout takes (a longer one fires at once). A token lives days, so the wait is re-armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

type StoredVerdict = { generation: number; scoped: ScopedVerdict | null };

/**
 * The app-wide launch state (Issue #49, phase 49B). It owns exactly three things and renders no UI of its own:
 *   1. ONE readiness probe (the existing `useBackendReadiness`), shared with the sign-in warm-up, paced by `probeDelayMs`.
 *   2. The session-scoped verdict: what the server said about THIS session, stored only through `recordVerdict` and read only
 *      through `verdictFor`, in memory. It is dropped whenever the session is replaced or ended (the store's session
 *      generation moves), and an answer for any other session is ignored.
 *   3. The pure decision, `deriveLaunchState`, re-evaluated when the session, the server status, the verdict, or the token's
 *      own expiry moves.
 * Nothing here decides anything the pure module does not; it supplies inputs and keeps them honest across the lifecycle.
 */
export default function LaunchProvider({ children }: { children: ReactNode }) {
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const generation = useAuthStore((s) => s.sessionGeneration);
  const readiness = useBackendReadiness(LAUNCH_PACING);

  // A trusted session stops being trusted the moment its token expires, even if nothing else changes: re-classify then.
  const [expiryTick, setExpiryTick] = useState(0);
  useEffect(() => {
    const expiresAt = getTokenExpiryMs(token);
    if (expiresAt === null) return;
    const wait = expiresAt - Date.now();
    if (wait <= 0) return; // already expired: classification below already says so
    const timer = setTimeout(() => setExpiryTick((n) => n + 1), Math.min(wait, MAX_TIMER_MS));
    return () => clearTimeout(timer);
  }, [token, expiryTick]);

  const [stored, setStored] = useState<StoredVerdict>({ generation, scoped: null });
  useEffect(
    () =>
      subscribeSessionAnswers((answer) => {
        // "Current" is read from the store at the moment the answer arrives, never from a render that may be behind.
        const { token: currentToken, sessionGeneration } = useAuthStore.getState();
        const currentKey = sessionKeyOf(currentToken);
        setStored((previous) => ({
          generation: sessionGeneration,
          scoped: recordVerdict(previous.generation === sessionGeneration ? previous.scoped : null, answer, currentKey),
        }));
      }),
    [],
  );

  const sessionKey = sessionKeyOf(token);
  const verdict = verdictFor(stored.generation === generation ? stored.scoped : null, sessionKey);

  const { phase, reason, retry } = readiness;
  const value = useMemo<LaunchContextValue>(
    () => ({
      decision: deriveLaunchState({
        session: classifySession({ token, user }),
        server: serverStatusFrom(phase, reason),
        verdict,
      }),
      readiness: { phase, reason, retry },
    }),
    // expiryTick is a deliberate dependency: classifySession reads the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [token, user, phase, reason, retry, verdict, expiryTick],
  );

  return <LaunchContext.Provider value={value}>{children}</LaunchContext.Provider>;
}
