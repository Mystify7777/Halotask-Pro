import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';
import styles from './AuthPages.module.css';

type StrengthLevel = 0 | 1 | 2 | 3;

function getPasswordStrength(pw: string): StrengthLevel {
  if (pw.length === 0) return 0;
  let score = 0;
  if (pw.length >= 8) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  return Math.min(score, 3) as StrengthLevel;
}

const STRENGTH_META: Record<StrengthLevel, { label: string; color: string; width: string }> = {
  0: { label: '', color: 'transparent', width: '0%' },
  1: { label: 'Weak', color: 'var(--color-danger)', width: '33%' },
  2: { label: 'Fair', color: 'var(--color-warning)', width: '66%' },
  3: { label: 'Strong', color: 'var(--color-success)', width: '100%' },
};

export default function RegisterPage() {
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.token);
  const setAuth = useAuthStore((state) => state.setAuth);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const strength = getPasswordStrength(password);
  const strengthMeta = STRENGTH_META[strength];
  const confirmMismatch = confirm.length > 0 && confirm !== password;

  useEffect(() => {
    if (isSessionTokenValid(token)) {
      navigate('/dashboard', { replace: true });
    }
  }, [token, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }

    setLoading(true);

    try {
      const result = await authService.register({ name: name.trim(), email: email.trim(), password });
      setAuth(result);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string }>;
      setError(axiosErr.response?.data?.message ?? 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className={styles.page}>
      <header className={styles.authHeader}>
        <button type="button" className={styles.backBtn} onClick={() => navigate('/home')} aria-label="Back to home">
          &larr;
        </button>
        <div className={styles.authLogoRow}>
          <span className={styles.authLogoEmoji} aria-hidden="true">
            🌱
          </span>
          <span className={styles.authLogoText}>halotask</span>
        </div>
      </header>

      <section className={styles.card} aria-label="Create account">
        <div className={styles.cardTop}>
          <h1 className={styles.cardTitle}>Create your account</h1>
          <p className={styles.cardSub}>Plant your first seed. It's completely free.</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <label>
            Your name
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ada Lovelace"
              required
              autoComplete="name"
              autoFocus
            />
          </label>

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
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 6 characters"
              required
              autoComplete="new-password"
              minLength={6}
            />
          </label>

          {password.length > 0 && (
            <div className={styles.strengthRow} aria-live="polite">
              <div className={styles.strengthBar}>
                <div
                  className={styles.strengthFill}
                  style={{
                    width: strengthMeta.width,
                    backgroundColor: strengthMeta.color,
                  }}
                />
              </div>
              <span className={styles.strengthLabel} style={{ color: strengthMeta.color }}>
                {strengthMeta.label}
              </span>
            </div>
          )}

          <label>
            Confirm password
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
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </div>
        </form>

        <p className={styles.switchLink}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </section>
    </main>
  );
}