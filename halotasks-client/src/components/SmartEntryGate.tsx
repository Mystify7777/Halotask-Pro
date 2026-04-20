import { Navigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { isKnownUser, isSessionTokenValid } from '../utils/authSession';

export default function SmartEntryGate() {
  const token = useAuthStore((state) => state.token);

  if (isSessionTokenValid(token)) {
    return <Navigate to="/dashboard" replace />;
  }

  if (isKnownUser()) {
    return <Navigate to="/login" replace />;
  }

  return <Navigate to="/home" replace />;
}
