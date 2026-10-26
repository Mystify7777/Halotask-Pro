import { useEffect, useMemo, useState } from 'react';
import { getApiErrorMessage } from '../../services/api';
import { userService } from '../../services/userService';
import { useAuthStore } from '../../store/authStore';
import { describeTimeZone, getDeviceTimeZone, listTimeZones } from '../../utils/timeZone';

type LoadState = 'loading' | 'ready' | 'failed';

// '' is the "no saved choice" option: it means "use this device's time zone" and is saved as null.
const DEVICE_VALUE = '';

/**
 * The time zone preference (Issue #41). The saved value lives on the server and in the auth store; this component
 * only ever shows what the server last confirmed, plus an unsaved selection the user is still making. A failed save
 * changes neither the saved value nor the effective zone.
 */
export default function TimeZoneSetting() {
  const user = useAuthStore((s) => s.user);
  const setUserTimeZone = useAuthStore((s) => s.setUserTimeZone);

  const saved = user?.timeZone ?? null;
  const deviceZone = getDeviceTimeZone();

  // undefined = the user has not touched the selector, so it simply follows the saved value.
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  const userId = user?.id;

  // Restore the server's value (it may have been changed on another device since this session loaded).
  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    setLoadState('loading');

    userService
      .getPreferences()
      .then((preferences) => {
        if (cancelled || useAuthStore.getState().user?.id !== userId) return;
        if ((useAuthStore.getState().user?.timeZone ?? null) !== preferences.timeZone) {
          setUserTimeZone(preferences.timeZone);
        }
        setLoadState('ready');
      })
      .catch(() => {
        if (!cancelled) setLoadState('failed');
      });

    return () => {
      cancelled = true;
    };
  }, [userId, setUserTimeZone]);

  const selected = draft ?? saved ?? DEVICE_VALUE;
  const dirty = selected !== (saved ?? DEVICE_VALUE);

  const effective = saved ?? deviceZone ?? 'UTC';
  const effectiveSource = saved ? 'your saved preference' : 'this device, not saved';

  // Every zone the runtime knows, plus any the selector must still be able to show (a saved or device zone the
  // runtime lists under another name, or UTC, which Intl does not list).
  const groups = useMemo(() => {
    const zones = new Set(listTimeZones());
    for (const zone of [saved, deviceZone, 'UTC']) if (zone) zones.add(zone);
    const byArea = new Map<string, string[]>();
    for (const zone of [...zones].sort()) {
      const area = zone.includes('/') ? zone.slice(0, zone.indexOf('/')) : 'Other';
      byArea.set(area, [...(byArea.get(area) ?? []), zone]);
    }
    return [...byArea.entries()];
  }, [saved, deviceZone]);

  const save = async () => {
    if (!dirty || saving || !userId) return;
    setSaving(true);
    setError(null);
    setJustSaved(false);

    try {
      const stored = await userService.updatePreferences({ timeZone: selected === DEVICE_VALUE ? null : selected });
      // Only the account that asked may be updated: the session could have changed while the request was in flight.
      if (useAuthStore.getState().user?.id === userId) {
        setUserTimeZone(stored.timeZone);
        setDraft(undefined);
        setJustSaved(true);
      }
    } catch (failure) {
      setError(getApiErrorMessage(failure, 'Could not save your time zone. Your previous setting is unchanged.'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="settings-section panel" aria-labelledby="timezone-heading">
      <h2 id="timezone-heading">Time zone</h2>

      <div className="setting-info">
        <label htmlFor="timezone-select" className="setting-label">
          Time zone for task times
        </label>
        <span id="timezone-desc" className="setting-desc">
          Due times and start times are read in this zone. Changing it never edits your tasks: a start time stays the
          same moment, and a due date and time keep the same date and clock reading.
        </span>
      </div>

      <div className="timezone-controls">
        <select
          id="timezone-select"
          className="timezone-select"
          value={selected}
          onChange={(event) => {
            setDraft(event.target.value);
            setJustSaved(false);
            setError(null);
          }}
          disabled={saving || loadState === 'loading'}
          aria-describedby="timezone-desc timezone-status"
        >
          <option value={DEVICE_VALUE}>
            {deviceZone ? `Use this device (${describeTimeZone(deviceZone)})` : 'Use this device'}
          </option>
          {groups.map(([area, zones]) => (
            <optgroup key={area} label={area}>
              {zones.map((zone) => (
                <option key={zone} value={zone}>
                  {describeTimeZone(zone)}
                </option>
              ))}
            </optgroup>
          ))}
        </select>

        <button type="button" className="btn-primary btn-sm" onClick={save} disabled={!dirty || saving || loadState === 'loading'}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>

      <div id="timezone-status" className="timezone-status">
        <p className="setting-status">
          {loadState === 'loading'
            ? 'Loading your saved time zone…'
            : `Using ${describeTimeZone(effective)} (${effectiveSource}).`}
        </p>
        {dirty && !saving && (
          <p className="setting-status" role="status">
            Unsaved change: not applied until you save.
          </p>
        )}
        {justSaved && !dirty && (
          <p className="setting-status" role="status">
            Time zone saved.
          </p>
        )}
        {loadState === 'failed' && (
          <p className="setting-status">Could not load your saved time zone from the server; showing the last known setting.</p>
        )}
      </div>

      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
