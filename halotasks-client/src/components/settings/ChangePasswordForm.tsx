import { useEffect, useState, type FormEvent } from 'react';
import { AxiosError } from 'axios';
import { runSessionSwap } from '../../services/api';
import { userService } from '../../services/userService';
import { useAuthStore } from '../../store/authStore';
import { subscribePush } from '../../hooks/usePushSubscription';
import PasswordInput from '../PasswordInput';

// Mirrors the server's rule (halotasks-server utils/validators.ts PASSWORD_MIN_LENGTH); the server stays the authority.
const PASSWORD_MIN_LENGTH = 6;

const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;

/** The sentence for a failed change. The server's codes are stable; anything else falls back to a generic line. */
export const describeChangeFailure = (error: unknown): string => {
  const response = (error as AxiosError<{ code?: string; message?: string }> | undefined)?.response;
  if (!response) return 'The password could not be changed (no answer from the server). If it may have changed, sign in again with the new password.';
  switch (response.data?.code) {
    case 'INVALID_CURRENT_PASSWORD':
      return 'The current password is incorrect.';
    case 'PASSWORD_UNCHANGED':
      return 'The new password must be different from the current one.';
    case 'PASSWORD_TOO_SHORT':
      return `The new password must be at least ${PASSWORD_MIN_LENGTH} characters long.`;
    case 'PASSWORD_CHANGED_ELSEWHERE':
      return 'The password was changed from somewhere else. Please sign in again.';
    default:
      break;
  }
  if (response.status === 429) return 'Too many attempts. Please try again later.';
  if (response.status === 401) return 'Your session has ended. Please sign in again.';
  return response.data?.message ?? 'The password could not be changed. Please try again.';
};

/**
 * Change password while signed in (Issue #46). Online only: nothing here is queued or retried, and the three fields live only in
 * this component's state (cleared after every attempt, successful or not). On success the session is replaced by the token the
 * server returned for the new generation, inside `runSessionSwap` so a stray 401 of the old token cannot sign the user out.
 */
export default function ChangePasswordForm() {
  const setAuth = useAuthStore((s) => s.setAuth);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [online, setOnline] = useState(isOnline);

  useEffect(() => {
    const update = () => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setDone(false);
    setError(null);

    if (!online) {
      setError('Changing your password needs a connection.');
      return;
    }
    if (!current) {
      setError('Enter your current password.');
      return;
    }
    if (next.length < PASSWORD_MIN_LENGTH) {
      setError(`The new password must be at least ${PASSWORD_MIN_LENGTH} characters long.`);
      return;
    }
    if (next === current) {
      setError('The new password must be different from the current one.');
      return;
    }
    if (next !== confirm) {
      setError('The new passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      await runSessionSwap(async () => {
        const answer = await userService.changePassword({ currentPassword: current, newPassword: next });
        // synchronous with the answer: the old token is already dead on the server
        setAuth({ token: answer.token, user: answer.user });
      });
      setDone(true);
      // The server emptied the push subscriptions; this device registers again when it is allowed to.
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') void subscribePush();
    } catch (failure) {
      setError(describeChangeFailure(failure));
    } finally {
      setCurrent('');
      setNext('');
      setConfirm('');
      setSaving(false);
    }
  };

  return (
    <form className="settings-password-form" onSubmit={submit} aria-label="Change password" noValidate>
      <label className="setting-label" htmlFor="current-password">
        Current password
      </label>
      <PasswordInput id="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />

      <label className="setting-label" htmlFor="new-password">
        New password
      </label>
      <PasswordInput id="new-password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} />

      <label className="setting-label" htmlFor="confirm-new-password">
        Confirm new password
      </label>
      <PasswordInput id="confirm-new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />

      {mismatch && (
        <p className="setting-desc" role="note">
          The new passwords do not match yet.
        </p>
      )}
      {!online && (
        <p className="setting-desc" role="note">
          Changing your password needs a connection.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {done && (
        <p className="setting-desc" role="status">
          Password changed. Your other devices were signed out.
        </p>
      )}

      <div className="setting-row">
        <span className="setting-desc">Forgot your current password? Sign out, then use “Forgot password” on the sign-in page.</span>
        <button type="submit" className="ghost-btn btn-sm" disabled={saving || !online}>
          {saving ? 'Changing…' : 'Change password'}
        </button>
      </div>
    </form>
  );
}
