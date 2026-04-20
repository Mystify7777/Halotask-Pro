import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const { token: resetToken } = useParams<{ token: string }>();
  const authToken = useAuthStore((state) => state.token);
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const token = useMemo(() => (resetToken || '').trim(), [resetToken]);

  useEffect(() => {
    if (isSessionTokenValid(authToken)) {
      navigate('/dashboard', { replace: true });
    }
  }, [authToken, navigate]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!token) {
      setError('Reset token is missing. Request a new reset link.');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);

    try {
      const result = await authService.resetPassword({ token, password });
      setMessage(result.message || 'Password updated. Please log in.');
      setTimeout(() => {
        navigate('/login', { replace: true });
      }, 1200);
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Unable to reset password. Please request a new reset link.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-page">
      <div className="auth-card">
        <h2>Reset Password</h2>
        <p>Choose a new password for your account.</p>

        <form onSubmit={handleSubmit} className="auth-form">
          <label>
            New password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </label>

          <label>
            Confirm password
            <input
              type="password"
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              required
              minLength={6}
              autoComplete="new-password"
            />
          </label>

          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-success">{message}</p>}

          <button type="submit" disabled={loading}>
            {loading ? 'Updating password...' : 'Update Password'}
          </button>
        </form>

        <p className="auth-link auth-secondary-link">
          Need a new token? <Link to="/forgot-password">Request reset link</Link>
        </p>
      </div>
    </section>
  );
}
