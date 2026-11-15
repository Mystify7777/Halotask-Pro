import { useState } from 'react';
import { usePlayWhileYouWait } from '../hooks/usePlayWhileYouWait';
import { useOptionalLaunch } from '../launch/launchContext';
import type { UnavailableCause } from '../launch/launchState';
import ColdStartOverlay from './dashboard/ColdStartOverlay';

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
 *
 * "Play while you wait" is the ONLY way the Task Tapper opens here: the person asks for it, nothing about the server's
 * state does. If the server comes back while it is open (a real recovery, never a flicker of the status), it closes with
 * the overlay's own "ready" beat; a game the person closed never reopens.
 */
export default function LaunchStatusLine() {
  // Without a provider (an isolated render of the layout) there is nothing to report.
  const launch = useOptionalLaunch();
  const cause = launch?.decision.state === 'offline-capable' ? launch.decision.unavailable : null;
  const game = usePlayWhileYouWait();
  // The recovery count when the game was opened: only a LATER recovery means "the server is back" (a brief change of the
  // status line, e.g. while "Check now" is running, is not).
  const [openedAt, setOpenedAt] = useState(0);
  const recovered = launch !== null && launch.serverRecoveries > openedAt;

  // The live region is always mounted and only its content comes and goes: a region that is inserted together with its
  // text is announced unreliably by screen readers, one that already exists is announced when its text appears.
  // The game is a sibling of the live region, not inside it: a dialog must not be announced as a status update.
  return (
    <>
      <div role="status" aria-live="polite" className="launch-status-region">
        {launch && cause && (
          <div className="launch-status" data-cause={cause}>
            <span>{COPY[cause]}</span>
            {cause !== 'browser-offline' && (
              <button type="button" className="ghost-btn btn-sm" onClick={launch.readiness.retry}>
                Check now
              </button>
            )}
            <button
              type="button"
              className="ghost-btn btn-sm"
              ref={game.playRef}
              disabled={game.playing}
              onClick={() => {
                setOpenedAt(launch.serverRecoveries);
                game.play();
              }}
            >
              Play while you wait
            </button>
          </div>
        )}
      </div>
      {launch && game.playing && (
        <ColdStartOverlay outcome={recovered ? 'ready' : 'waking'} onExited={game.close} onDismiss={game.close} />
      )}
    </>
  );
}
