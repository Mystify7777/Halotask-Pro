import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';
import styles from './AuthPages.module.css';

export default function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const token = useAuthStore((state) => state.token);
  const setAuth = useAuthStore((state) => state.setAuth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const from = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  useEffect(() => {
    if (isSessionTokenValid(token)) {
      navigate('/dashboard', { replace: true });
    }
  }, [token, navigate]);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      // Trim email to prevent whitespace login mismatches.
      const result = await authService.login({ email: email.trim(), password });
      setAuth(result);
      navigate(from, { replace: true });
    } catch (err) {
      const axiosErr = err as AxiosError<{ message?: string }>;
      setError(axiosErr.response?.data?.message ?? 'Login failed. Please try again.');
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

      <section className={styles.card} aria-label="Sign in">
        <div className={styles.cardTop}>
          <h1 className={styles.cardTitle}>Welcome back</h1>
          <p className={styles.cardSub}>Sign in to continue growing your tree.</p>
        </div>

        <form onSubmit={handleSubmit} className="auth-form" noValidate>
          <label>
            Email address
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              required
              autoComplete="email"
              autoFocus
              inputMode="email"
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="********"
              required
              autoComplete="current-password"
            />
          </label>

          <div className={styles.forgotRow}>
            <Link to="/forgot-password" className={styles.forgotLink}>
              Forgot password?
            </Link>
          </div>

          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}

          <div className="auth-cta-stack">
            <button type="submit" className="btn-primary" disabled={loading}>
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </div>
        </form>

        <p className={styles.switchLink}>
          Don't have an account? <Link to="/register">Create one free</Link>
        </p>
      </section>
    </main>
  );
}