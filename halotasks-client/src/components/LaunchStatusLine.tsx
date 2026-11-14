import { useOptionalLaunch } from '../launch/launchContext';
import type { UnavailableCause } from '../launch/launchState';

const COPY: Record<UnavailableCause, string> = {
  'browser-offline': "You're offline. You can keep working: changes are saved on this device and will sync when you're back online.",
  waking: 'The server is waking up. You can keep working: changes are saved on this device and will sync automatically.',
  timeout: "We can't reach the server right now. You can keep working: changes are saved on this device and will sync when it's back.",
  unhealthy: 'The server is having trouble right now. You can keep working: changes are saved on this device and will sync when it recovers.',
};

/**
 * One slim line for the one honest thing a trusted session needs to know while the server is unavailable
 * (`offline-capable`, Issue #49). It appears only then, says why in plain words, never calls it a sign-in problem, and
 * disappears by itself when the server is back. It reads the decision; it checks nothing. "Check now" asks the shared
 * readiness probe again (not offered when the browser itself is offline, which a button cannot fix).
 */
export default function LaunchStatusLine() {
  // Without a provider (an isolated render of the layout) there is nothing to report.
  const launch = useOptionalLaunch();
  if (!launch || launch.decision.state !== 'offline-capable' || !launch.decision.unavailable) return null;
  const { readiness } = launch;
  const cause = launch.decision.unavailable;

  return (
    <div className="launch-status" role="status" data-cause={cause}>
      <span>{COPY[cause]}</span>
      {cause !== 'browser-offline' && (
        <button type="button" className="ghost-btn btn-sm" onClick={readiness.retry}>
          Check now
        </button>
      )}
    </div>
  );
}
