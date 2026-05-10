import { useNavigate } from 'react-router-dom';
import { useTheme } from '../App';
import { THEMES } from '../theme';
import styles from './HomePage.module.css';

function SkyScene({ theme }: { theme: string }) {
  const isNight = theme === 'night';
  const isSunset = theme === 'sunset';
  const isMidday = theme === 'midday';

  const bodyX = isSunset ? 58 : isMidday ? 190 : 270;
  const bodyY = isMidday ? 36 : isSunset ? 90 : 60;
  const bodyR = isMidday ? 32 : isNight ? 22 : 28;

  return (
    <svg className={styles.skySvg} viewBox="0 0 390 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect width="390" height="220" fill="var(--color-sky-bg)" />

      {isNight && (
        <g opacity="0.9">
          <circle cx="40" cy="28" r="1.5" fill="#fff" />
          <circle cx="110" cy="14" r="1" fill="#fff" />
          <circle cx="170" cy="38" r="1.5" fill="#fff" />
          <circle cx="230" cy="18" r="1" fill="#fff" />
          <circle cx="300" cy="48" r="1.5" fill="#fff" />
          <circle cx="28" cy="72" r="1" fill="#fff" />
          <circle cx="155" cy="62" r="1" fill="#fff" />
          <circle cx="340" cy="24" r="1" fill="#fff" />
          <circle cx="360" cy="80" r="1.2" fill="#fff" />
          <circle cx="80" cy="55" r="1" fill="#fff" />
        </g>
      )}

      <circle cx={bodyX} cy={bodyY} r={bodyR} fill={isNight ? '#E8EAF6' : 'var(--color-sky-body)'} />

      {isNight && (
        <>
          <circle cx={bodyX - 6} cy={bodyY + 4} r="4" fill="rgba(0,0,0,0.08)" />
          <circle cx={bodyX + 8} cy={bodyY - 5} r="3" fill="rgba(0,0,0,0.06)" />
        </>
      )}

      {!isNight && (
        <circle
          cx={bodyX}
          cy={bodyY}
          r={bodyR + 10}
          fill="none"
          stroke="var(--color-sky-body)"
          strokeOpacity="0.25"
          strokeWidth="8"
        />
      )}

      {!isNight && (
        <g fill="var(--color-sky-cloud)">
          <ellipse cx="88" cy="72" rx="40" ry="18" />
          <ellipse cx="118" cy="64" rx="24" ry="14" />
          <ellipse cx="210" cy="112" rx="32" ry="14" />
          <ellipse cx="238" cy="106" rx="20" ry="10" />
        </g>
      )}

      <path d="M0 160 Q98 140 195 155 Q292 170 390 148 L390 220 L0 220 Z" fill="var(--color-bg)" />

      <g opacity="0.18" fill="var(--color-text-primary)">
        <rect x="191" y="152" width="6" height="36" rx="3" />
        <ellipse cx="194" cy="147" rx="20" ry="17" />
        <ellipse cx="183" cy="153" rx="13" ry="11" />
        <ellipse cx="205" cy="153" rx="13" ry="11" />
        <ellipse cx="194" cy="137" rx="15" ry="12" />
      </g>
    </svg>
  );
}

function TreeLogo() {
  return (
    <svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <rect x="12" y="18" width="4" height="8" rx="2" fill="rgba(255,255,255,0.75)" />
      <ellipse cx="14" cy="15" rx="9" ry="8" fill="rgba(255,255,255,0.9)" />
      <ellipse cx="8" cy="17" rx="6" ry="5" fill="rgba(255,255,255,0.7)" />
      <ellipse cx="20" cy="17" rx="6" ry="5" fill="rgba(255,255,255,0.7)" />
      <ellipse cx="14" cy="9" rx="7" ry="6" fill="rgba(255,255,255,0.8)" />
      <circle cx="17" cy="13" r="1.5" fill="rgba(255,210,80,0.95)" />
      <circle cx="11" cy="16" r="1.2" fill="rgba(255,210,80,0.95)" />
    </svg>
  );
}

interface FeatureCardProps {
  emoji: string;
  title: string;
  desc: string;
}

function FeatureCard({ emoji, title, desc }: FeatureCardProps) {
  return (
    <article className="feature-card">
      <div className={styles.featEmoji} aria-hidden="true">
        {emoji}
      </div>
      <h2>{title}</h2>
      <p>{desc}</p>
    </article>
  );
}

function ThemeDots() {
  const { theme, setThemeOverride } = useTheme();

  return (
    <div className={styles.themeDots} role="group" aria-label="Preview a theme">
      {THEMES.map((t) => (
        <button
          key={t.name}
          className={`${styles.themeDot} ${theme === t.name ? styles.themeDotActive : ''}`}
          style={{ background: t.dotColor }}
          onClick={() => setThemeOverride(theme === t.name ? null : t.name)}
          aria-label={`${t.emoji} ${t.label} (${t.timeRange})`}
          aria-pressed={theme === t.name}
          title={`${t.label} - ${t.timeRange}`}
        />
      ))}
    </div>
  );
}

export default function HomePage() {
  const { theme } = useTheme();
  const navigate = useNavigate();

  return (
    <main className={styles.page} aria-label="Halotask Pro home">
      <section className={styles.hero}>
        <div className={styles.skyWrap}>
          <SkyScene theme={theme} />
        </div>

        <div className={styles.logoRow}>
          <div className={styles.logoIcon} aria-hidden="true">
            <TreeLogo />
          </div>
          <span className={styles.logoText}>halotask</span>
        </div>

        <div className={styles.heroCopy}>
          <h1 className={styles.tagline}>
            Grow through
            <br />
            what you do.
          </h1>
          <p className={styles.sub}>
            Your tasks feed a living tree. Build streaks, earn XP, and watch your focus bloom - one check at a time.
          </p>

          <div className={styles.ctaStack}>
            <button className="btn-primary" onClick={() => navigate('/register')}>
              Get started - it's free
            </button>
            <button className="btn-secondary" onClick={() => navigate('/login')}>
              Sign in to your account
            </button>
          </div>
        </div>
      </section>

      <section className={styles.features} aria-label="Features">
        <div className="feature-grid">
          <FeatureCard emoji="🌱" title="Living tree" desc="Complete tasks to grow your tree through five stages - seed to ancient." />
          <FeatureCard emoji="📴" title="Works offline" desc="Full offline mode with background sync when you reconnect." />
          <FeatureCard emoji="🔔" title="Smart reminders" desc="Quiet hours, deadline alerts, and work-session nudges." />
          <FeatureCard emoji="🎨" title="Adaptive theme" desc="Colours shift with your day - sunrise to night sky." />
        </div>
      </section>

      <section className={styles.themePreview} aria-label="Theme preview">
        <p className={styles.themePreviewLabel}>Tap a dot to preview a theme - Auto-adjusts to your local time</p>
        <ThemeDots />
      </section>
    </main>
  );
}
