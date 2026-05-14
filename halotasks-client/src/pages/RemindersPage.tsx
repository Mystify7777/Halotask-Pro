import { useState } from 'react';
import {
  getReminderSettings,
  saveReminderSettings,
  ReminderSettings,
  BufferMinutes,
} from '../reminders/settings';
import {
  getNotificationPermissionStatus,
  isNotificationSupported,
  requestNotificationPermission,
} from '../reminders/permissions';

const BUFFER_OPTIONS: { value: BufferMinutes; label: string }[] = [
  { value: 15, label: '15 minutes' },
  { value: 30, label: '30 minutes' },
  { value: 60, label: '1 hour' },
  { value: 90, label: '90 minutes' },
];

const ALERT_TYPES: {
  key: keyof Pick<
    ReminderSettings,
    'dueSoonEnabled' | 'overdueEnabled' | 'workSessionSoonEnabled' | 'startNowEnabled'
  >;
  label: string;
  desc: string;
  id: string;
}[] = [
  {
    key: 'dueSoonEnabled',
    label: 'Due soon',
    desc: 'Notify when a task is due within the buffer window',
    id: 'alert-due-soon',
  },
  {
    key: 'overdueEnabled',
    label: 'Overdue',
    desc: 'Notify when a task is past its due date',
    id: 'alert-overdue',
  },
  {
    key: 'workSessionSoonEnabled',
    label: 'Work session soon',
    desc: 'Notify before a scheduled work session starts',
    id: 'alert-work-session',
  },
  {
    key: 'startNowEnabled',
    label: 'Start now',
    desc: "Notify when it's time to begin a task",
    id: 'alert-start-now',
  },
];

function PermissionCard({
  permission,
  supported,
  onRequest,
}: {
  permission: NotificationPermission;
  supported: boolean;
  onRequest: () => Promise<void>;
}) {
  const [requesting, setRequesting] = useState(false);

  const handleRequest = async () => {
    setRequesting(true);
    await onRequest();
    setRequesting(false);
  };

  if (!supported) {
    return (
      <div className="permission-card permission-card--denied">
        <span className="permission-card-icon" aria-hidden="true">🚫</span>
        <div>
          <strong>Notifications not supported</strong>
          <p>Your browser doesn't support web notifications.</p>
        </div>
      </div>
    );
  }

  if (permission === 'granted') {
    return (
      <div className="permission-card permission-card--granted">
        <span className="permission-card-icon" aria-hidden="true">✓</span>
        <div>
          <strong>Notifications enabled</strong>
          <p>Halotask can send you reminder alerts.</p>
        </div>
      </div>
    );
  }

  if (permission === 'denied') {
    return (
      <div className="permission-card permission-card--denied">
        <span className="permission-card-icon" aria-hidden="true">✕</span>
        <div>
          <strong>Notifications blocked</strong>
          <p>
            Enable notifications for Halotask in your browser settings,
            then reload the page.
          </p>
        </div>
      </div>
    );
  }

  // 'default' — not yet asked
  return (
    <div className="permission-card permission-card--default">
      <span className="permission-card-icon" aria-hidden="true">🔔</span>
      <div>
        <strong>Notifications not enabled</strong>
        <p>Allow notifications so Halotask can remind you about upcoming tasks.</p>
      </div>
      <button
        type="button"
        className="btn-primary btn-sm"
        onClick={handleRequest}
        disabled={requesting}
        aria-busy={requesting}
      >
        {requesting ? 'Requesting…' : 'Enable notifications'}
      </button>
    </div>
  );
}

export default function RemindersPage() {
  const [settings, setSettings] = useState<ReminderSettings>(getReminderSettings);
  const [permission, setPermission] = useState<NotificationPermission>(
    getNotificationPermissionStatus,
  );
  const supported = isNotificationSupported();

  const update = (partial: Partial<ReminderSettings>) => {
    const next = { ...settings, ...partial };
    setSettings(next);
    saveReminderSettings(next);
  };

  const handleRequestPermission = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
  };

  return (
    <div className="settings-page">

      {/* ── Browser permission ──────────────────────────────────── */}
      <section className="settings-section panel">
        <h2>Notification permission</h2>
        <PermissionCard
          permission={permission}
          supported={supported}
          onRequest={handleRequestPermission}
        />
      </section>

      {/* ── General ────────────────────────────────────────────── */}
      <section className="settings-section panel">
        <h2>General</h2>

        <div className="setting-row setting-row--top">
          <div className="setting-info">
            <label htmlFor="reminders-enabled" className="setting-label" style={{ cursor: 'pointer' }}>
              Enable reminders
            </label>
            <span id="reminders-enabled-desc" className="setting-desc">
              Master switch — turn all reminder notifications on or off
            </span>
          </div>
          <label className="toggle-switch">
            <input
              id="reminders-enabled"
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => update({ enabled: e.target.checked })}
              aria-describedby="reminders-enabled-desc"
            />
            <span className="toggle-track"><span className="toggle-thumb" /></span>
          </label>
        </div>

        <hr className="setting-divider" />

        <div className="setting-row">
          <label htmlFor="buffer-time" className="setting-label">
            Buffer time
          </label>
          <select
            id="buffer-time"
            value={String(settings.bufferMinutes)}
            onChange={(e) =>
              update({ bufferMinutes: Number(e.target.value) as BufferMinutes })
            }
            aria-label="Reminder buffer time"
          >
            {BUFFER_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* ── Alert types ─────────────────────────────────────────── */}
      <section className="settings-section panel">
        <h2>Alert types</h2>
        {ALERT_TYPES.map((alert, index) => (
          <div key={alert.key}>
            {index > 0 && <hr className="setting-divider" />}
            <div className="setting-row setting-row--top">
              <div className="setting-info">
                <label
                  htmlFor={alert.id}
                  className="setting-label"
                  style={{ cursor: 'pointer' }}
                >
                  {alert.label}
                </label>
                <span className="setting-desc">{alert.desc}</span>
              </div>
              <label className="toggle-switch">
                <input
                  id={alert.id}
                  type="checkbox"
                  checked={settings[alert.key]}
                  onChange={(e) => update({ [alert.key]: e.target.checked })}
                  disabled={!settings.enabled}
                />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
            </div>
          </div>
        ))}
      </section>

      {/* ── Quiet hours ─────────────────────────────────────────── */}
      <section className="settings-section panel">
        <h2>Quiet hours</h2>
        <p className="setting-desc">
          No reminders will be sent during this window.
        </p>
        <div className="quiet-hours-grid">
          <label className="setting-info">
            <span className="setting-label">Start</span>
            <input
              type="time"
              value={settings.quietHoursStart}
              onChange={(e) => update({ quietHoursStart: e.target.value })}
              aria-label="Quiet hours start"
            />
          </label>
          <label className="setting-info">
            <span className="setting-label">End</span>
            <input
              type="time"
              value={settings.quietHoursEnd}
              onChange={(e) => update({ quietHoursEnd: e.target.value })}
              aria-label="Quiet hours end"
            />
          </label>
        </div>
      </section>

    </div>
  );
}
