import { createContext, useContext } from 'react';
import type { BackendFailureReason, BackendReadinessPhase } from '../hooks/useBackendReadiness';
import type { LaunchDecision } from './launchState';

/** The one app-wide readiness probe, as the existing hook reports it (Issue #12), plus its manual re-check. */
export type SharedReadiness = { phase: BackendReadinessPhase; reason: BackendFailureReason | null; retry: () => void };

export type LaunchContextValue = {
  /** What the app may show now. Render by `decision.access`, never by `decision.state` alone. */
  decision: LaunchDecision;
  readiness: SharedReadiness;
  /** Times the server came back after being unavailable. Moves only on a real recovery, never on a brief healthy re-check. */
  serverRecoveries: number;
};

export const LaunchContext = createContext<LaunchContextValue | null>(null);

export function useLaunch(): LaunchContextValue {
  const value = useContext(LaunchContext);
  if (!value) throw new Error('useLaunch must be used inside <LaunchProvider>');
  return value;
}

/** For code that must also work without the provider (the sign-in warm-up keeps its own probe when rendered alone). */
export const useOptionalLaunch = (): LaunchContextValue | null => useContext(LaunchContext);

/** Recoveries seen so far; 0 without a provider (isolated renders), so a consumer simply never re-syncs there. */
export const useServerRecoveries = (): number => useContext(LaunchContext)?.serverRecoveries ?? 0;
