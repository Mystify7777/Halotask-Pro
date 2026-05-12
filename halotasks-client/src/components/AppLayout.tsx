import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { useTheme } from '../App';
import styles from './AppLayout.module.css';

type OrbRegistrar = { register: (fn: () => void) => () => void };
const OrbContext = createContext<OrbRegistrar>({ register: () => () => {} });

export function useRegisterOrbTap(fn: () => void): void {
  const { register } = useContext(OrbContext);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    return register(() => fnRef.current());
  }, [register]);
}

const NAV_ITEMS = [
  { id: 'tasks', label: 'Tasks', emoji: '✅', path: '/dashboard' },
  { id: 'insights', label: 'Insights', emoji: '📊', path: '/dashboard/insights' },
  { id: 'reminders', label: 'Reminders', emoji: '🔔', path: '/dashboard/reminders' },
  { id: 'settings', label: 'Settings', emoji: '⚙️', path: '/dashboard/settings' },
] as const;

type NavId = (typeof NAV_ITEMS)[number]['id'];

function TreeOrbSvg() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="16" y="24" width="4" height="9" rx="2" fill="#A1887F" />
      <ellipse cx="18" cy="20" rx="10" ry="9" fill="#66BB6A" />
      <ellipse cx="11" cy="22" rx="7" ry="6" fill="#81C784" />
      <ellipse cx="25" cy="22" rx="7" ry="6" fill="#81C784" />
      <ellipse cx="18" cy="13" rx="8" ry="7" fill="#A5D6A7" />
      <circle cx="22" cy="18" r="2" fill="#FF8A65" opacity="0.9" />
      <circle cx="15" cy="21" r="1.5" fill="#FF8A65" opacity="0.9" />
      <circle cx="19" cy="24" r="1.5" fill="#FFCC02" opacity="0.9" />
    </svg>
  );
}

type AppLayoutProps = {
  children: React.ReactNode;
  xp?: number;
  stage?: string;
  xpToNext?: number;
  progressPct?: number;
};

export default function AppLayout({
  children,
  xp = 0,
  stage = 'Seed',
  xpToNext = 100,
  progressPct = 0,
}: AppLayoutProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthStore((s) => s.user);
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const { theme } = useTheme();

  const [orbTooltipVisible, setOrbTooltipVisible] = useState(false);
  const [tooltipTimer, setTooltipTimer] = useState<ReturnType<typeof setTimeout> | null>(null);

  const orbHandlerRef = useRef<(() => void) | null>(null);
  const orbContextValue = useMemo<OrbRegistrar>(() => ({
    register: (fn) => {
      orbHandlerRef.current = fn;
      return () => {
        orbHandlerRef.current = null;
      };
    },
  }), []);

  const activeNav: NavId = (() => {
    if (location.pathname.includes('insights')) return 'insights';
    if (location.pathname.includes('reminders')) return 'reminders';
    if (location.pathname.includes('settings')) return 'settings';
    return 'tasks';
  })();

  const handleLogout = () => {
    clearAuth();
    navigate('/login', { replace: true });
  };

  const handleOrbTap = () => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;

    if (orbHandlerRef.current && isMobile) {
      orbHandlerRef.current();
      return;
    }

    if (tooltipTimer) clearTimeout(tooltipTimer);
    setOrbTooltipVisible(true);
    const id = setTimeout(() => setOrbTooltipVisible(false), 1500);
    setTooltipTimer(id);
  };

  const greeting = (() => {
    if (theme === 'sunrise') return 'Good morning';
    if (theme === 'midday') return 'Good afternoon';
    if (theme === 'sunset') return 'Good evening';
    return 'Good night';
  })();

  return (
    <OrbContext.Provider value={orbContextValue}>
    <div className={`app-shell ${styles.shell}`}>
      <header className={`top-nav ${styles.header}`}>
        <div className="brand">
          <span className={styles.brandMark} aria-hidden="true">🌱</span>
          <div>
            <h1 className={styles.brandName}>halotask</h1>
            <p className={styles.brandGreeting}>{greeting}{user?.name ? `, ${user.name.split(' ')[0]}` : ''} 👋</p>
          </div>
        </div>

        {/* Desktop-only nav — hidden on mobile via CSS module */}
        <nav className={styles.desktopNav} aria-label="Desktop navigation">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`${styles.desktopNavLink} ${activeNav === item.id ? styles.desktopNavLinkActive : ''}`}
              onClick={() => navigate(item.path)}
              aria-current={activeNav === item.id ? 'page' : undefined}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="user-actions">
          <button
            type="button"
            className={styles.logoutBtn}
            onClick={handleLogout}
            aria-label="Sign out"
          >
            Sign out
          </button>
        </div>
      </header>

      <main className={`main-grid ${styles.main}`}>{children}</main>

      <div className={`orb-wrap ${styles.orbWrap}`}>
        <button
          type="button"
          className="orb"
          onClick={handleOrbTap}
          aria-label={`Growth tree - ${stage}, ${xp} XP. Tap for details.`}
        >
          <TreeOrbSvg />
          <div className="orb-xp">
            <span>{xp} XP · {stage}</span>
          </div>
        </button>

        <div className={`orb-tooltip ${orbTooltipVisible ? 'visible' : ''}`} aria-live="polite">
          <p className="orb-ttl">🌱 {stage}</p>
          <p className="orb-sub">{xpToNext} XP to next stage</p>
          <div className="orb-prog">
            <div className="progress-bar-wrap">
              <div className="progress-bar" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        </div>
      </div>

      <button
        type="button"
        className={`fab ${styles.fab}`}
        aria-label="Add new task"
        onClick={() => {
          navigate('/dashboard', { state: { openCreate: true } });
        }}
      >
        +
      </button>

      <nav className="bottom-nav" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            type="button"
            className={`nav-item ${activeNav === item.id ? 'active' : ''}`}
            onClick={() => navigate(item.path)}
            aria-current={activeNav === item.id ? 'page' : undefined}
          >
            <span className="nav-item-icon" aria-hidden="true">{item.emoji}</span>
            <span className="nav-item-label">{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
    </OrbContext.Provider>
  );
}