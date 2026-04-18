export type BufferMinutes = 15 | 30 | 60 | 90;

export type ReminderSettings = {
  enabled: boolean;
  bufferMinutes: BufferMinutes;
  dueSoonEnabled: boolean;
  overdueEnabled: boolean;
  workSessionSoonEnabled: boolean;
  startNowEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
};

const STORAGE_KEY = 'halotasks_reminder_settings';

export const defaultReminderSettings: ReminderSettings = {
  enabled: true,
  bufferMinutes: 60,
  dueSoonEnabled: true,
  overdueEnabled: true,
  workSessionSoonEnabled: true,
  startNowEnabled: true,
  quietHoursStart: '22:30',
  quietHoursEnd: '07:00',
};

const isBufferMinutes = (value: number): value is BufferMinutes => {
  return value === 15 || value === 30 || value === 60 || value === 90;
};

const normalizeTime = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') {
    return fallback;
  }

  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return fallback;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return fallback;
  }

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
};

export const getReminderSettings = (): ReminderSettings => {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return defaultReminderSettings;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ReminderSettings>;
    const parsedBuffer = Number(parsed.bufferMinutes);

    return {
      enabled: parsed.enabled ?? defaultReminderSettings.enabled,
      bufferMinutes: isBufferMinutes(parsedBuffer) ? parsedBuffer : defaultReminderSettings.bufferMinutes,
      dueSoonEnabled: parsed.dueSoonEnabled ?? defaultReminderSettings.dueSoonEnabled,
      overdueEnabled: parsed.overdueEnabled ?? defaultReminderSettings.overdueEnabled,
      workSessionSoonEnabled: parsed.workSessionSoonEnabled ?? defaultReminderSettings.workSessionSoonEnabled,
      startNowEnabled: parsed.startNowEnabled ?? defaultReminderSettings.startNowEnabled,
      quietHoursStart: normalizeTime(parsed.quietHoursStart, defaultReminderSettings.quietHoursStart),
      quietHoursEnd: normalizeTime(parsed.quietHoursEnd, defaultReminderSettings.quietHoursEnd),
    };
  } catch {
    return defaultReminderSettings;
  }
};

export const saveReminderSettings = (settings: ReminderSettings) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
};

const timeToMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return null;
  }

  return hours * 60 + minutes;
};

export const isWithinQuietHours = (date: Date, settings: ReminderSettings) => {
  const startMinutes = timeToMinutes(settings.quietHoursStart);
  const endMinutes = timeToMinutes(settings.quietHoursEnd);

  if (startMinutes === null || endMinutes === null || startMinutes === endMinutes) {
    return false;
  }

  const nowMinutes = date.getHours() * 60 + date.getMinutes();

  if (startMinutes < endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes < endMinutes;
  }

  return nowMinutes >= startMinutes || nowMinutes < endMinutes;
};
