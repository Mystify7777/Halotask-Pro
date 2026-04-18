import { ReminderSettings as ReminderSettingsType, BufferMinutes } from '../../reminders/settings';

type ReminderSettingsProps = {
  isOpen: boolean;
  settings: ReminderSettingsType;
  onToggleOpen: () => void;
  onSettingsChange: (next: ReminderSettingsType) => void;
};

const BUFFER_OPTIONS: BufferMinutes[] = [15, 30, 60, 90];

export default function ReminderSettings({ isOpen, settings, onToggleOpen, onSettingsChange }: ReminderSettingsProps) {
  const updateSettings = (partial: Partial<ReminderSettingsType>) => {
    onSettingsChange({
      ...settings,
      ...partial,
    });
  };

  return (
    <div className="reminder-settings-wrap">
      <button type="button" className="ghost-btn reminder-settings-btn" onClick={onToggleOpen}>
        Reminder Settings
      </button>

      {isOpen && (
        <div className="reminder-settings-panel">
          <label className="inline-check-label">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(event) => updateSettings({ enabled: event.target.checked })}
            />
            Enable reminders
          </label>

          <label>
            Buffer time
            <select
              value={String(settings.bufferMinutes)}
              onChange={(event) => updateSettings({ bufferMinutes: Number(event.target.value) as BufferMinutes })}
            >
              {BUFFER_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {option} minutes
                </option>
              ))}
            </select>
          </label>

          <div className="settings-group">
            <label className="inline-check-label">
              <input
                type="checkbox"
                checked={settings.dueSoonEnabled}
                onChange={(event) => updateSettings({ dueSoonEnabled: event.target.checked })}
              />
              Due soon alerts
            </label>
            <label className="inline-check-label">
              <input
                type="checkbox"
                checked={settings.overdueEnabled}
                onChange={(event) => updateSettings({ overdueEnabled: event.target.checked })}
              />
              Overdue alerts
            </label>
            <label className="inline-check-label">
              <input
                type="checkbox"
                checked={settings.workSessionSoonEnabled}
                onChange={(event) => updateSettings({ workSessionSoonEnabled: event.target.checked })}
              />
              Work session soon alerts
            </label>
            <label className="inline-check-label">
              <input
                type="checkbox"
                checked={settings.startNowEnabled}
                onChange={(event) => updateSettings({ startNowEnabled: event.target.checked })}
              />
              Start now alerts
            </label>
          </div>

          <div className="quiet-hours-row">
            <label>
              Quiet start
              <input
                type="time"
                value={settings.quietHoursStart}
                onChange={(event) => updateSettings({ quietHoursStart: event.target.value })}
              />
            </label>
            <label>
              Quiet end
              <input
                type="time"
                value={settings.quietHoursEnd}
                onChange={(event) => updateSettings({ quietHoursEnd: event.target.value })}
              />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
