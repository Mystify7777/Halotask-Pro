import { FormEvent, useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';

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
    if (token) {
      navigate('/dashboard', { replace: true });
    }
  }, [token, navigate]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const result = await authService.login({ email, password });
      setAuth(result);
      navigate(from, { replace: true });
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-page">
      <div className="auth-shell">
        <article className="auth-showcase" aria-label="HaloTaskPro product highlights">
          <p className="auth-eyebrow">HaloTaskPro</p>
          <h1 className="auth-hero-title">Focus momentum, even when your connection does not.</h1>
          <p className="auth-hero-copy">
            Plan and execute with a task workspace built for real life: offline-first sync, smart reminders, and a
            Growth Tree that makes consistency visible.
          </p>

          <div className="feature-grid">
            <article className="feature-card">
              <h2>Offline-First Sync</h2>
              <p>Create, update, and complete tasks offline. Your queue reconciles when you reconnect.</p>
            </article>
            <article className="feature-card">
              <h2>Smart Reminders</h2>
              <p>Due-soon alerts, start-time prompts, and quiet hours tuned for focused execution.</p>
            </article>
            <article className="feature-card">
              <h2>Growth Tree Motivation</h2>
              <p>Every completion becomes progress. Streaks, stages, and XP turn discipline into momentum.</p>
            </article>
            <article className="feature-card">
              <h2>Fast Task Control</h2>
              <p>Search, filters, sorting, and bulk actions keep your daily review crisp and actionable.</p>
            </article>
          </div>

          <div className="cta-band" role="note" aria-label="Call to action">
            <p>Ready to run your day with intention?</p>
            <Link className="cta-link" to="/register">
              Create Free Workspace
            </Link>
          </div>
        </article>

        <div className="auth-card">
          <h2>Welcome Back</h2>
          <p>Sign in to continue your focused workflow.</p>

          <form onSubmit={handleSubmit} className="auth-form">
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>

            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
              />
            </label>

            {error && <p className="form-error">{error}</p>}

            <button type="submit" disabled={loading}>
              {loading ? 'Signing in...' : 'Login'}
            </button>
          </form>

          <p className="auth-link">
            No account yet? <Link to="/register">Create one</Link>
          </p>
        </div>
      </div>
    </section>
  );
}