import { useEffect, useState } from 'react';
import { useBackendReadiness, type BackendFailureReason } from '../hooks/useBackendReadiness';
import ColdStartOverlay from './dashboard/ColdStartOverlay';

const FAILURE_COPY: Record<BackendFailureReason, string> = {
  timeout:
    "We couldn't reach the server, so it may be down or your connection may be unstable. You can still try again, or check once more.",
  unhealthy:
    "The server is running but can't reach its database right now. You can still try again, or check once more in a moment.",
};

/**
 * Pre-login cold-start experience (Issue #12). Drop it into a page that must work before anyone is signed in (login,
 * register). It reuses the dashboard's ColdStartOverlay as is, driven by real readiness probes instead of a request timer,
 * and reads nothing from the auth store, the task store or any protected endpoint.
 *
 *  - Backend answers fast: renders nothing, and the page behaves exactly as before.
 *  - Backend is waking: the overlay runs until a probe gets a healthy answer, then closes itself and the form is usable.
 *    The user can also dismiss it early; the form never depends on it.
 *  - Backend failed: the overlay closes quietly (it never claims "ready") and a notice says what failed, separately from
 *    a normal wait. It does not block the form and offers another check.
 */
export default function BackendWarmup() {
  const { phase, reason, retry } = useBackendReadiness();
  const [overlayOpen, setOverlayOpen] = useState(false);

  useEffect(() => {
    if (phase === 'waking') setOverlayOpen(true);
  }, [phase]);

  const outcome = phase === 'waking' ? 'waking' : phase === 'ready' ? 'ready' : 'error';

  return (
    <>
      {overlayOpen && (
        <ColdStartOverlay outcome={outcome} onExited={() => setOverlayOpen(false)} onDismiss={() => setOverlayOpen(false)} />
      )}
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
