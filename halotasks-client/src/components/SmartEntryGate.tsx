import { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useLaunch } from '../launch/launchContext';
import { hasCompletedOnboarding, isKnownUser } from '../utils/authSession';

/**
 * Root route handler - three-way gate, driven by the launch decision (Issue #49):
 *   a session the launch has not sent to sign-in  -> the app  (/dashboard, or /onboarding the first time). The protected
 *                                                    route then shows the app, the quiet hold or the waiting room, so a
 *                                                    refresh at "/" while the server is down reaches the same screen
 *                                                    as a refresh anywhere else
 *   returning user                                -> /login  (they know the app)
 *   first-time visitor                            -> /home   (show the landing page)
 */
export default function SmartEntryGate(): ReactElement {
  const { decision } = useLaunch();

  if (decision.access !== 'login') {
    if (!hasCompletedOnboarding()) return <Navigate to="/onboarding" replace />;
    return <Navigate to="/dashboard" replace />;
  }
  if (isKnownUser()) return <Navigate to="/login" replace />;
  return <Navigate to="/home" replace />;
}
