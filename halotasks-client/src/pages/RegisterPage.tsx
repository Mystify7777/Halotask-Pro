import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';

export default function RegisterPage() {
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.token);
  const setAuth = useAuthStore((state) => state.setAuth);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
      const result = await authService.register({ name, email, password });
      setAuth(result);
      navigate('/dashboard', { replace: true });
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Registration failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-page">
      <div className="auth-shell">
        <article className="auth-showcase" aria-label="HaloTaskPro registration benefits">
          <p className="auth-eyebrow">Your Productive System</p>
          <h1 className="auth-hero-title">Build a reliable routine with less friction.</h1>
          <p className="auth-hero-copy">
            HaloTaskPro keeps task execution resilient and motivating: offline continuity, reminder intelligence,
            progress psychology, and fast control surfaces for daily planning.
          </p>

          <div className="cta-band" role="note" aria-label="Sign in call to action">
            <p>Already have an account?</p>
            <Link className="cta-link" to="/login">
              Sign In
            </Link>
          </div>
        </article>

        <div className="auth-card">
          <h2>Create Workspace</h2>
          <p>Start organizing with HaloTaskPro.</p>

          <form onSubmit={handleSubmit} className="auth-form">
            <label>
              Name
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                required
                autoComplete="name"
              />
            </label>

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
                autoComplete="new-password"
                minLength={6}
              />
            </label>

            {error && <p className="form-error">{error}</p>}

            <button type="submit" disabled={loading}>
              {loading ? 'Creating account...' : 'Register'}
            </button>
          </form>

          <p className="auth-link">
            Already registered? <Link to="/login">Sign in</Link>
          </p>
        </div>
      </div>
    </section>
  );
}