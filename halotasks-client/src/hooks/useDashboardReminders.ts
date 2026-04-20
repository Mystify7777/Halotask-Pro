import { useEffect, useRef, useState } from 'react';
import { sendReminderNotification } from '../reminders/notification';
import {
  getNotificationPermissionStatus,
  isNotificationSupported,
  requestNotificationPermission,
} from '../reminders/permissions';
import { createReminderScheduler } from '../reminders/scheduler';
import { getReminderSettings, ReminderSettings as ReminderSettingsType, saveReminderSettings } from '../reminders/settings';
import type { Task } from '../types/task';

type UseDashboardRemindersArgs = {
  getTasks: () => Task[];
  setStatusInfo: (message: string | null) => void;
  setStatusError: (message: string | null) => void;
};

export function useDashboardReminders({
  getTasks,
  setStatusInfo,
  setStatusError,
}: UseDashboardRemindersArgs) {
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(
    getNotificationPermissionStatus(),
  );
  const [reminderSettings, setReminderSettings] = useState<ReminderSettingsType>(getReminderSettings());
  const [isReminderSettingsOpen, setIsReminderSettingsOpen] = useState(false);

  const remindersSupported = isNotificationSupported();

  const reminderSettingsRef = useRef<ReminderSettingsType>(reminderSettings);
  const reminderSchedulerRef = useRef<ReturnType<typeof createReminderScheduler> | null>(null);

  useEffect(() => {
    reminderSettingsRef.current = reminderSettings;
    saveReminderSettings(reminderSettings);
    reminderSchedulerRef.current?.runNow();
  }, [reminderSettings]);

  useEffect(() => {
    if (!remindersSupported) {
      return;
    }

    if (!reminderSchedulerRef.current) {
      reminderSchedulerRef.current = createReminderScheduler({
        getTasks,
        getSettings: () => reminderSettingsRef.current,
        onReminder: ({ task, type }) => {
          sendReminderNotification(task, type);
        },
        intervalMs: 60_000,
      });
    }

    if (notificationPermission === 'granted') {
      reminderSchedulerRef.current.start();
    } else {
      reminderSchedulerRef.current.stop();
    }

    return () => {
      reminderSchedulerRef.current?.stop();
    };
  }, [getTasks, notificationPermission, remindersSupported]);

  const handleEnableReminders = async () => {
    const permission = await requestNotificationPermission();
    setNotificationPermission(permission);

    if (permission === 'granted') {
      setStatusInfo('Reminder notifications enabled.');
      setStatusError(null);
    } else if (permission === 'denied') {
      setStatusError('Notifications are blocked. Enable browser notifications for reminder alerts.');
    }
  };

  const handleReminderSettingsChange = (next: ReminderSettingsType) => {
    setReminderSettings(next);
    setStatusInfo('Reminder settings updated.');
  };

  return {
    remindersSupported,
    notificationPermission,
    reminderSettings,
    isReminderSettingsOpen,
    setIsReminderSettingsOpen,
    handleEnableReminders,
    handleReminderSettingsChange,
  };
}
