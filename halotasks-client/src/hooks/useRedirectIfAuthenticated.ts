import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';

export const useRedirectIfAuthenticated = (to = '/dashboard') => {
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.token);

  useEffect(() => {
    if (isSessionTokenValid(token)) {
      navigate(to, { replace: true });
    }
  }, [navigate, token, to]);
};