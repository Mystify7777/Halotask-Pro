import { useEffect, useRef, useState } from 'react';
import { getReminderPayload, sendReminderNotification } from '../reminders/notification';
import {
  getNotificationPermissionStatus,
  isNotificationSupported,
  requestNotificationPermission,
} from '../reminders/permissions';
import { createReminderScheduler } from '../reminders/scheduler';
import { getReminderSettings, ReminderSettings as ReminderSettingsType, saveReminderSettings } from '../reminders/settings';
import { useAuthStore } from '../store/authStore';
import { relayToServer, subscribePush } from './usePushSubscription';
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

  // A changed time zone moves the calendar day date-only reminders are judged in: re-evaluate now rather than at the
  // next poll. Task data is untouched; the scheduler's day receipts keep it from re-sending what already went out.
  const timeZone = useAuthStore((state) => state.user?.timeZone);
  useEffect(() => {
    reminderSchedulerRef.current?.runNow();
  }, [timeZone]);

  useEffect(() => {
    if (!remindersSupported) {
      return;
    }

    if (!reminderSchedulerRef.current) {
      reminderSchedulerRef.current = createReminderScheduler({
        getTasks,
        getSettings: () => reminderSettingsRef.current,
        onReminder: ({ task, type }) => {
          const shown = sendReminderNotification(task, type);
          void relayToServer(getReminderPayload(task, type));
          return shown; // a date-only day reminder that was not shown is retried (reminders/scheduler.ts)
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

  useEffect(() => {
    if (notificationPermission === 'granted') {
      void subscribePush();
    }
  }, [notificationPermission]);

  const handleEnableReminders = async () => {
    const permission = await requestNotificationPermission();
    setNotificationPermission(permission);

    if (permission === 'granted') {
      setStatusInfo('Reminder notifications enabled.');
      setStatusError(null);
      void subscribePush();
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
