import { ReactElement, ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useLaunch } from '../launch/launchContext';
import LaunchHoldPage from '../pages/LaunchHoldPage';
import WaitingRoomPage from '../pages/WaitingRoomPage';
import { hasCompletedOnboarding } from '../utils/authSession';

type AuthEntryRouteProps = {
  children: ReactNode;
  /** After registering, a first-time user is taken to onboarding rather than the dashboard. */
  onboardingAware?: boolean;
};

/**
 * Wraps the public sign-in routes (login, register, forgot and reset password) with the SAME launch contract as
 * `ProtectedRoute` (Issue #49), so a session the launch does not trust cannot use them to step around the waiting room.
 * It renders what `decision.access` allows and decides nothing else; the pages themselves hold no launch policy.
 *   app           already in: go to the app
 *   hold          the quiet "checking" screen
 *   waiting-room  the waiting room: an unverified session is never shown a form while the server is unavailable
 *   login         the sign-in page (signed out, rejected, or an unconfirmed session the server has answered for)
 */
export default function AuthEntryRoute({ children, onboardingAware = false }: AuthEntryRouteProps): ReactElement {
  const { decision } = useLaunch();

  switch (decision.access) {
    case 'app':
      return <Navigate to={onboardingAware && !hasCompletedOnboarding() ? '/onboarding' : '/dashboard'} replace />;
    case 'hold':
      return <LaunchHoldPage />;
    case 'waiting-room':
      return <WaitingRoomPage />;
    case 'login':
      return <>{children}</>;
    default: {
      const unhandled: never = decision.access;
      return unhandled;
    }
  }
}
