import { Link, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

type AppLayoutProps = {
  children: React.ReactNode;
};

export default function AppLayout({ children }: AppLayoutProps) {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const clearAuth = useAuthStore((state) => state.clearAuth);

  const handleLogout = () => {
    clearAuth();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <header className="top-nav">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            H
          </span>
          <div>
            <h1>HaloTasks</h1>
            <p>Phase 1 Dashboard</p>
          </div>
        </div>
        <div className="user-actions">
          <span className="welcome">{user ? `Welcome, ${user.name}` : 'Signed in'}</span>
          <button className="ghost-btn" onClick={handleLogout}>
            Logout
          </button>
        </div>
      </header>

      <div className="main-grid">
        <aside className="sidebar">
          <p className="sidebar-title">Navigation</p>
          <Link to="/dashboard" className="nav-link">
            Dashboard
          </Link>
          <button className="nav-link disabled-link" disabled>
            Analytics (later)
          </button>
          <button className="nav-link disabled-link" disabled>
            Tree System (later)
          </button>
        </aside>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}