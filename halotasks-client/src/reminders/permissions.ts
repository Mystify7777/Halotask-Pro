export const isNotificationSupported = () => typeof window !== 'undefined' && 'Notification' in window;

export const getNotificationPermissionStatus = (): NotificationPermission => {
  if (!isNotificationSupported()) {
    return 'denied';
  }

  return Notification.permission;
};

export const requestNotificationPermission = async (): Promise<NotificationPermission> => {
  if (!isNotificationSupported()) {
    return 'denied';
  }

  if (Notification.permission === 'granted') {
    return 'granted';
  }

  return Notification.requestPermission();
};
