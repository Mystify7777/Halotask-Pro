import { useEffect, useState } from 'react';

export const getIsOnline = () => {
  if (typeof navigator === 'undefined') {
    return true;
  }

  return navigator.onLine;
};

export const useNetworkStatus = () => {
  const [isOnline, setIsOnline] = useState(getIsOnline());

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  return { isOnline };
};
