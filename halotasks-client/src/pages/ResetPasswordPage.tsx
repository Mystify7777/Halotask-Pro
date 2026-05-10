import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';
import styles from './AuthPages.module.css';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const authToken = useAuthStore((s) => s.token);

  const prefilledEmail = (location.state as { email?: string } | null)?.email ?? '';

  const [email, setEmail] = useState(prefilledEmail);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (isSessionTokenValid(authToken)) {
      navigate('/dashboard', { replace: true });
    }
  }, [authToken, navigate]);

  useEffect(() => {
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  const confirmMismatch = confirm.length > 0 && confirm !== password;

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!email.trim()) {
      setError('Email is required.');
      return;
    }

    if (!code.trim()) {
      setError('Reset code is required.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      await authService.resetPassword({
        email: email.trim(),
        token: code.trim(),
        password,
      });
      setSuccess(true);
      redirectTimer.current = setTimeout(() => {
        navigate('/login', { replace: true });
      }, 2000);
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string }>;
      setError(axiosErr.response?.data?.message ?? 'Unable to reset password. Please try again or request a new code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.authHeader}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={() => navigate('/forgot-password')}
          aria-label="Back to forgot password"
        >
          &larr;
        </button>
        <div className={styles.authLogoRow}>
          <span className={styles.authLogoEmoji} aria-hidden="true">
            🌱
          </span>
          <span className={styles.authLogoText}>halotask</span>
        </div>
      </header>

      <section className={styles.card} aria-label="Reset password">
        {success ? (
          <>
            <div className={styles.cardTop}>
              <h1 className={styles.cardTitle}>Password updated!</h1>
              <p className={styles.cardSub}>Redirecting you to sign in...</p>
            </div>
            <div className={styles.successBox} role="status">
              <p className={styles.successTitle}>✅ All done</p>
              <p className={styles.successBody}>
                Your password has been reset. You'll be redirected to the sign in page in a moment.
              </p>
            </div>
            <div className="auth-cta-stack">
              <button
                type="button"
                className="btn-primary"
                onClick={() => {
                  if (redirectTimer.current) clearTimeout(redirectTimer.current);
                  navigate('/login', { replace: true });
                }}
              >
                Sign in now
              </button>
            </div>
          </>
        ) : (
          <>
            <div className={styles.cardTop}>
              <h1 className={styles.cardTitle}>Set a new password</h1>
              <p className={styles.cardSub}>Enter the 6-digit code from your email and choose a new password.</p>
            </div>

            <form onSubmit={handleSubmit} className="auth-form" noValidate>
              <label>
                Email address
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  required
                  autoComplete="email"
                  inputMode="email"
                  autoFocus={!prefilledEmail}
                />
              </label>

              <label>
                Reset code
                <input
                  className={styles.tokenInput}
                  type="text"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="000000"
                  required
                  maxLength={6}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus={!!prefilledEmail}
                />
              </label>

              <label>
                New password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  required
                  minLength={6}
                  autoComplete="new-password"
                />
              </label>

              <label>
                Confirm new password
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Type it again"
                  required
                  autoComplete="new-password"
                  style={confirmMismatch ? { borderColor: 'var(--color-danger)' } : undefined}
                />
              </label>

              {confirmMismatch && (
                <p className="form-error" role="alert" style={{ marginTop: 'calc(var(--space-2) * -1)' }}>
                  Passwords don't match
                </p>
              )}

              {error && (
                <p className="form-error" role="alert">
                  {error}
                </p>
              )}

              <div className="auth-cta-stack">
                <button type="submit" className="btn-primary" disabled={loading || confirmMismatch}>
                  {loading ? 'Updating password...' : 'Reset password'}
                </button>
              </div>
            </form>
          </>
        )}

        <p className={styles.switchLink}>
          <Link to="/login">Back to sign in</Link>
        </p>
      </section>
    </main>
  );
}
