import { useEffect, useMemo, useState } from 'react';
import { getApiErrorMessage } from '../../services/api';
import { userService } from '../../services/userService';
import { useAuthStore } from '../../store/authStore';
import type { EmailReminderPreferences, EmailReminderUpdate } from '../../types/auth';
import { getReminderSettings } from '../../reminders/settings';
import { listTimeZones } from '../../utils/timeZone';

type LoadState = 'loading' | 'ready' | 'failed';

const BUFFER_OPTIONS = [15, 30, 60, 90] as const;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;
// '' is the "use the account time zone" option; it is saved as null.
const FOLLOW_ACCOUNT = '';

const ALERTS: Array<{ key: 'dueSoonEnabled' | 'overdueEnabled' | 'workSessionSoonEnabled' | 'startNowEnabled'; id: string; label: string }> = [
  { key: 'dueSoonEnabled', id: 'email-alert-due-soon', label: 'Due soon (and tasks due today)' },
  { key: 'overdueEnabled', id: 'email-alert-overdue', label: 'Overdue' },
  { key: 'workSessionSoonEnabled', id: 'email-alert-work-session', label: 'Work session soon' },
  { key: 'startNowEnabled', id: 'email-alert-start-now', label: 'Start now' },
];

/** The server's defaults for the fields a first-time opt-in copies from the browser reminder settings. */
const SEEDED_DEFAULTS = { dueSoonEnabled: true, overdueEnabled: true, workSessionSoonEnabled: true, startNowEnabled: true, bufferMinutes: 60, quietHoursStart: '22:30', quietHoursEnd: '07:00' } as const;

const untouched = (prefs: EmailReminderPreferences): boolean =>
  (Object.keys(SEEDED_DEFAULTS) as Array<keyof typeof SEEDED_DEFAULTS>).every((key) => prefs[key] === SEEDED_DEFAULTS[key]);

/**
 * Email reminders (Issue #29): an explicit opt-in that lives on the server, because the server sends the email while this
 * browser may be closed. This component only ever shows what the server last confirmed; a failed save changes nothing on
 * screen. It never sends email, and holds no provider detail: the server tells it only whether email is available.
 *
 * Turning email on for the first time copies the browser's current alert choices, buffer and quiet hours, so email starts
 * out matching what the user already chose; after that the two are independent.
 */
export default function EmailReminderSettings() {
  const userId = useAuthStore((s) => s.user?.id);
  const accountEmail = useAuthStore((s) => s.user?.email);

  const [prefs, setPrefs] = useState<EmailReminderPreferences | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoadState('loading');
    userService
      .getEmailReminders()
      .then((loaded) => {
        if (cancelled) return;
        setPrefs(loaded);
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('failed');
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const zones = useMemo(() => {
    const all = new Set(listTimeZones());
    all.add('UTC');
    if (prefs?.timeZone) all.add(prefs.timeZone);
    return [...all].sort();
  }, [prefs?.timeZone]);

  const save = async (update: EmailReminderUpdate) => {
    if (saving || !userId) return;
    setSaving(true);
    setError(null);
    try {
      const stored = await userService.updateEmailReminders(update);
      // Only the account that asked may be updated: the session could have changed while the request was in flight.
      if (useAuthStore.getState().user?.id === userId) setPrefs(stored);
    } catch (failure) {
      setError(getApiErrorMessage(failure, 'Could not save your email reminder settings. Your previous settings are unchanged.'));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = (enabled: boolean) => {
    if (!prefs) return;
    if (enabled && untouched(prefs)) {
      const browser = getReminderSettings();
      void save({
        enabled: true,
        dueSoonEnabled: browser.dueSoonEnabled,
        overdueEnabled: browser.overdueEnabled,
        workSessionSoonEnabled: browser.workSessionSoonEnabled,
        startNowEnabled: browser.startNowEnabled,
        bufferMinutes: browser.bufferMinutes,
        quietHoursStart: HH_MM.test(browser.quietHoursStart) ? browser.quietHoursStart : '22:30',
        quietHoursEnd: HH_MM.test(browser.quietHoursEnd) ? browser.quietHoursEnd : '07:00',
      });
      return;
    }
    void save({ enabled });
  };

  const saveTime = (field: 'quietHoursStart' | 'quietHoursEnd' | 'digestTime', value: string) => {
    // A time input is briefly empty while it is being edited; only a complete HH:mm is saved.
    if (HH_MM.test(value)) void save({ [field]: value });
  };

  if (loadState === 'loading') {
    return (
      <section className="settings-section panel" aria-labelledby="email-reminders-heading">
        <h2 id="email-reminders-heading">Email reminders</h2>
        <p className="setting-desc">Loading your email reminder settings…</p>
      </section>
    );
  }

  if (loadState === 'failed' || !prefs) {
    return (
      <section className="settings-section panel" aria-labelledby="email-reminders-heading">
        <h2 id="email-reminders-heading">Email reminders</h2>
        <p className="setting-desc" role="alert">
          Email reminder settings could not be loaded. They need a connection to the server; try again later.
        </p>
      </section>
    );
  }

  const noZoneSaved = prefs.timeZone === null && prefs.accountTimeZone === null;
  const disabled = saving;

  return (
    <section className="settings-section panel" aria-labelledby="email-reminders-heading">
      <h2 id="email-reminders-heading">Email reminders</h2>

      {!prefs.available && (
        <p className="setting-desc" role="note">
          Email delivery is not set up on this server, so no email will be sent even if you turn this on.
        </p>
      )}

      <div className="setting-row setting-row--top">
        <div className="setting-info">
          <label htmlFor="email-reminders-enabled" className="setting-label" style={{ cursor: 'pointer' }}>
            Email me reminders
          </label>
          <span id="email-reminders-enabled-desc" className="setting-desc">
            Off by default. Reminders go only to {accountEmail ?? 'your account email'}, even when the app is closed, and follow
            your quiet hours below.
          </span>
        </div>
        <label className="toggle-switch">
          <input
            id="email-reminders-enabled"
            type="checkbox"
            checked={prefs.enabled}
            onChange={(event) => toggleEnabled(event.target.checked)}
            disabled={disabled}
            aria-describedby="email-reminders-enabled-desc"
          />
          <span className="toggle-track"><span className="toggle-thumb" /></span>
        </label>
      </div>

      {prefs.enabled && (
        <>
          <hr className="setting-divider" />
          <h3 className="setting-label">Which reminders</h3>
          {ALERTS.map((alert) => (
            <div className="setting-row" key={alert.key}>
              <label htmlFor={alert.id} className="setting-label" style={{ cursor: 'pointer' }}>{alert.label}</label>
              <label className="toggle-switch">
                <input id={alert.id} type="checkbox" checked={prefs[alert.key]} disabled={disabled} onChange={(event) => void save({ [alert.key]: event.target.checked })} />
                <span className="toggle-track"><span className="toggle-thumb" /></span>
              </label>
            </div>
          ))}

          <div className="setting-row">
            <label htmlFor="email-buffer-time" className="setting-label">Heads-up before a planned start</label>
            <select
              id="email-buffer-time"
              value={String(prefs.bufferMinutes)}
              disabled={disabled}
              onChange={(event) => void save({ bufferMinutes: Number(event.target.value) as EmailReminderPreferences['bufferMinutes'] })}
            >
              {BUFFER_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>{minutes} minutes</option>
              ))}
            </select>
          </div>

          <hr className="setting-divider" />
          <h3 className="setting-label">Quiet hours for email</h3>
          <div className="quiet-hours-grid">
            <label className="setting-info">
              <span className="setting-label">Start</span>
              <input type="time" value={prefs.quietHoursStart} disabled={disabled} aria-label="Email quiet hours start" onChange={(event) => saveTime('quietHoursStart', event.target.value)} />
            </label>
            <label className="setting-info">
              <span className="setting-label">End</span>
              <input type="time" value={prefs.quietHoursEnd} disabled={disabled} aria-label="Email quiet hours end" onChange={(event) => saveTime('quietHoursEnd', event.target.value)} />
            </label>
          </div>

          <hr className="setting-divider" />
          <h3 className="setting-label">Daily digest</h3>
          <div className="setting-row setting-row--top">
            <div className="setting-info">
              <label htmlFor="email-digest-enabled" className="setting-label" style={{ cursor: 'pointer' }}>Send a daily summary</label>
              <span id="email-digest-desc" className="setting-desc">
                One email a day: what is overdue, what is due today and what is coming in the next 3 days. Nothing is sent on a day
                with nothing to report, and quiet hours delay it.
              </span>
            </div>
            <label className="toggle-switch">
              <input id="email-digest-enabled" type="checkbox" checked={prefs.digestEnabled} disabled={disabled} aria-describedby="email-digest-desc" onChange={(event) => void save({ digestEnabled: event.target.checked })} />
              <span className="toggle-track"><span className="toggle-thumb" /></span>
            </label>
          </div>
          {prefs.digestEnabled && (
            <div className="setting-row">
              <label htmlFor="email-digest-time" className="setting-label">Send it at</label>
              <input id="email-digest-time" type="time" value={prefs.digestTime} disabled={disabled} onChange={(event) => saveTime('digestTime', event.target.value)} />
            </div>
          )}

          <hr className="setting-divider" />
          <div className="setting-info">
            <label htmlFor="email-timezone" className="setting-label">Email time zone</label>
            <span id="email-timezone-desc" className="setting-desc">
              Quiet hours, the digest and &ldquo;today&rdquo; are read in this zone. By default it follows your account time zone,
              including when you change that later.
            </span>
          </div>
          <select
            id="email-timezone"
            value={prefs.timeZone ?? FOLLOW_ACCOUNT}
            disabled={disabled}
            aria-describedby="email-timezone-desc"
            onChange={(event) => void save({ timeZone: event.target.value === FOLLOW_ACCOUNT ? null : event.target.value })}
          >
            <option value={FOLLOW_ACCOUNT}>Use account time zone ({prefs.accountTimeZone ?? 'none saved, UTC'})</option>
            {zones.map((zone) => (
              <option key={zone} value={zone}>{zone}</option>
            ))}
          </select>
          {noZoneSaved && (
            <p className="setting-desc" role="note">
              No time zone is saved, so email times use UTC. Pick one here, or save your time zone in Settings.
            </p>
          )}
        </>
      )}

      {error && <p className="setting-desc" role="alert">{error}</p>}
    </section>
  );
}
