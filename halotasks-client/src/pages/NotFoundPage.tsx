import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section className="auth-page">
      <div className="auth-card">
        <h1>Page Not Found</h1>
        <p>The page you requested does not exist.</p>
        <Link to="/">Go to Home</Link>
      </div>
    </section>
  );
}