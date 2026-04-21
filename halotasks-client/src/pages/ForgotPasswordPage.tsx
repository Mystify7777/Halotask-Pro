import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AxiosError } from 'axios';
import { authService } from '../services/authService';
import { useAuthStore } from '../store/authStore';
import { isSessionTokenValid } from '../utils/authSession';

const neutralMessage = 'If an account exists for this email, check your inbox for a reset code (or your spam folder). The code expires in 15 minutes.';

export default function ForgotPasswordPage() {
  const navigate = useNavigate();
  const token = useAuthStore((state) => state.token);
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (isSessionTokenValid(token)) {
      navigate('/dashboard', { replace: true });
    }
  }, [navigate, token]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    setMessage(null);
    setLoading(true);

    try {
      const result = await authService.forgotPassword({ email });
      setMessage(result.message || neutralMessage);
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      if (axiosError.response?.status === 429) {
        setError(axiosError.response.data?.message ?? 'Too many requests. Please try again later.');
      } else {
        setMessage(neutralMessage);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="auth-page">
      <div className="auth-card">
        <h2>Forgot Password</h2>
        <p>Enter your email to receive a password reset code.</p>

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

          {error && <p className="form-error">{error}</p>}
          {message && <p className="form-success">{message}</p>}

          <button type="submit" disabled={loading}>
            {loading ? 'Sending code...' : 'Send Reset Code'}
          </button>
        </form>

        <p className="auth-link auth-secondary-link">
          Back to <Link to="/login">Sign in</Link>
        </p>
      </div>
    </section>
  );
}
