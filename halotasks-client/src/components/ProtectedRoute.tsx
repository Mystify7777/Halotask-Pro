import { ReactElement, ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';

type ProtectedRouteProps = { children: ReactNode };

/**
 * Wraps any route that requires authentication.
 * Redirects unauthenticated users to /login, preserving the
 * intended destination in router state so LoginPage can redirect back.
 */
export default function ProtectedRoute({ children }: ProtectedRouteProps): ReactElement {
  const token = useAuthStore((s) => s.token);
  const location = useLocation();

  if (!isSessionTokenValid(token)) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname }}
      />
    );
  }

  return <>{children}</>;
}