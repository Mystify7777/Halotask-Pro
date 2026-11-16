import { usePlayWhileYouWait } from '../hooks/usePlayWhileYouWait';
import { useBackendReadiness, type BackendFailureReason } from '../hooks/useBackendReadiness';
import { useOptionalLaunch, type SharedReadiness } from '../launch/launchContext';
import ColdStartOverlay from './dashboard/ColdStartOverlay';

const FAILURE_COPY: Record<BackendFailureReason, string> = {
  timeout:
    "We couldn't reach the server, so it may be down or your connection may be unstable. You can still try again, or check once more.",
  unhealthy:
    "The server is running but can't reach its database right now. You can still try again, or check once more in a moment.",
};

/**
 * Pre-login cold-start experience (Issue #12, changed by the "game opens only on request" follow-up). Drop it into a page
 * that must work before anyone is signed in (login, register, forgot and reset password). It is driven by real readiness
 * probes, and reads nothing from the auth store, the task store or any protected endpoint.
 *
 *  - Backend answers fast: renders nothing visible, and the page behaves exactly as before.
 *  - Backend is waking: a calm notice says so, with "Play while you wait". The Task Tapper (ColdStartOverlay) opens ONLY
 *    from that button, never because the server is slow. If the backend gets a healthy answer while it is open, it closes
 *    with the overlay's "ready" beat; a game the person closed never reopens. The form never depends on any of it.
 *  - Backend failed: the notice goes away, an open game closes quietly (it never claims "ready"), and an alert says what
 *    failed, separately from a normal wait. It does not block the form and offers another check.
 */
export default function BackendWarmup() {
  // Inside the app there is ONE readiness probe (Issue #49, LaunchProvider); this shows its answer instead of starting a
  // second one. Rendered on its own (no provider), it keeps its own probe exactly as before.
  const shared = useOptionalLaunch();
  return shared ? <WarmupView {...shared.readiness} /> : <WarmupWithOwnProbe />;
}

function WarmupWithOwnProbe() {
  return <WarmupView {...useBackendReadiness()} />;
}

function WarmupView({ phase, reason, retry }: SharedReadiness) {
  const game = usePlayWhileYouWait();

  // Only a real "ready" answer says ready; a failure closes an open game quietly; any other moment (a re-check under way)
  // leaves it as it is.
  const outcome = phase === 'ready' ? 'ready' : phase === 'waking' || phase === 'checking' ? 'waking' : 'error';

  // The live region is always mounted and only its content comes and goes (a region inserted together with its text is
  // announced unreliably). The game is a sibling of it: a dialog must not be announced as a status update.
  return (
    <>
      <div role="status" aria-live="polite">
        {phase === 'waking' && (
          <div className="warmup-notice" data-testid="backend-warmup-waking">
            <span>The server is waking up, which can take a minute. Signing in will work as soon as it is ready.</span>
            <button type="button" className="ghost-btn btn-sm" ref={game.playRef} disabled={game.playing} onClick={game.play}>
              Play while you wait
            </button>
          </div>
        )}
      </div>
      {game.playing && <ColdStartOverlay outcome={outcome} onExited={game.close} onDismiss={game.close} />}
      {phase === 'error' && reason && (
        <div className="form-error" role="alert" data-testid="backend-warmup-failure" data-reason={reason}>
          <p>{FAILURE_COPY[reason]}</p>
          <button type="button" className="btn-secondary" onClick={retry}>
            Check again
          </button>
        </div>
      )}
    </>
  );
}
