import { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useLaunch } from '../launch/launchContext';
import LaunchHoldPage from '../pages/LaunchHoldPage';
import WaitingRoomPage from '../pages/WaitingRoomPage';

type ProtectedRouteProps = { children: ReactNode };

/**
 * Wraps any route that requires authentication. It does not decide anything: it renders what the launch decision allows
 * (Issue #49), by `access` and never by `state`, which is what keeps the policy in one place.
 *   app           the protected page
 *   hold          a quiet "checking" screen: nothing protected, nothing alarming (a decision is still pending)
 *   waiting-room  the explanation + wait experience (the session cannot be trusted and the server is not reachable)
 *   login         /login, remembering the intended destination so LoginPage can return there
 */
export default function ProtectedRoute({ children }: ProtectedRouteProps): ReactElement {
  const { decision } = useLaunch();
  const location = useLocation();

  switch (decision.access) {
    case 'app':
      return <>{children}</>;
    case 'hold':
      return <LaunchHoldPage />;
    case 'waiting-room':
      return <WaitingRoomPage />;
    case 'login':
      return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    default: {
      const unhandled: never = decision.access;
      return unhandled;
    }
  }
}
