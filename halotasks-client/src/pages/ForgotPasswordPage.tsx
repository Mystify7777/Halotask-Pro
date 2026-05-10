import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';
import styles from './AuthPages.module.css';

const NEUTRAL_MESSAGE =
  'If an account exists for this email, a reset code is on its way. ' +
  'Check your inbox (and spam folder). The code expires in 20 minutes.';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const token = useAuthStore((s) => s.token);

  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (isSessionTokenValid(token)) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate, token]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await authService.forgotPassword({ email: email.trim() });
      setSent(true);
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string }>;
      if (axiosErr.response?.status === 429) {
        setError(axiosErr.response.data?.message ?? 'Too many requests. Please wait before trying again.');
      } else {
        setSent(true);
      }
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
          onClick={() => navigate('/login')}
          aria-label="Back to sign in"
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

      <section className={styles.card} aria-label="Forgot password">
        <div className={styles.cardTop}>
          <h1 className={styles.cardTitle}>Forgot password?</h1>
          <p className={styles.cardSub}>Enter your email and we'll send you a reset code.</p>
        </div>

        {sent ? (
          <>
            <div className={styles.successBox} role="status">
              <p className={styles.successTitle}>📬 Code sent!</p>
              <p className={styles.successBody}>{NEUTRAL_MESSAGE}</p>
            </div>

            <div className="auth-cta-stack">
              <button
                type="button"
                className="btn-primary"
                onClick={() => navigate('/reset-password', { state: { email } })}
              >
                Enter reset code &rarr;
              </button>
            </div>

            <div className={styles.resendRow}>
              <button
                type="button"
                className={styles.resendBtn}
                onClick={() => {
                  setSent(false);
                  setError(null);
                }}
              >
                Didn't receive it? Send again
              </button>
            </div>
          </>
        ) : (
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
                autoFocus
                inputMode="email"
              />
            </label>

            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}

            <div className="auth-cta-stack">
              <button type="submit" className="btn-primary" disabled={loading}>
                {loading ? 'Sending...' : 'Send reset code'}
              </button>
            </div>
          </form>
        )}

        <p className={styles.switchLink}>
          Remembered it? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}
