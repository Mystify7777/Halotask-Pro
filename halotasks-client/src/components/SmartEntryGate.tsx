import { ReactElement } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { isKnownUser, isSessionTokenValid } from '../utils/authSession';

/**
 * Root route handler - three-way gate:
 *   authenticated        -> /dashboard  (skip login entirely)
 *   returning user       -> /login      (they know the app)
 *   first-time visitor   -> /home       (show the landing page)
 */
export default function SmartEntryGate(): ReactElement {
  const token = useAuthStore((s) => s.token);

  if (isSessionTokenValid(token)) return <Navigate to="/dashboard" replace />;
  if (isKnownUser()) return <Navigate to="/login" replace />;
  return <Navigate to="/home" replace />;
}
