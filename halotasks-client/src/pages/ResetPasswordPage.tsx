import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  const authToken = useAuthStore((state) => state.token);
  const [email, setEmail] = useState('');
  const [token, setToken] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isSessionTokenValid(authToken)) {
      navigate('/dashboard', { replace: true });
    }
  }, [authToken, navigate]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);

    if (!email.trim()) {
      setError('Email is required.');
      return;
    }

    if (!token.trim()) {
      setError('Reset code is required.');
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
      const result = await authService.resetPassword({
        email: email.trim(),
        token: token.trim(),
        password,
      });
      setMessage(result.message || 'Password updated. Please log in.');
      setTimeout(() => {
        navigate('/login', { replace: true });
      }, 1200);
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Unable to reset password. Please try again or request a new code.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-page">
      <div className="auth-card">
        <h2>Reset Password</h2>
        <p>Enter the code from your email and choose a new password.</p>

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
            Reset code
            <input
              type="text"
              value={token}
              onChange={(event) => setToken(event.target.value.toUpperCase())}
              placeholder="Enter 6-digit code"
              required
              maxLength={10}
            />
          </label>

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
            {loading ? 'Resetting password...' : 'Reset Password'}
          </button>
        </form>

        <p className="auth-link auth-secondary-link">
          Back to <Link to="/login">Sign in</Link>
        </p>
      </div>
    </section>
  );
}
