import { useNavigate } from 'react-router-dom';
import { useTheme } from '../App';
import { useAuthStore } from '../store/authStore';
import type { CSSProperties } from 'react';

export default function SettingsPage() {
  const navigate = useNavigate();
  const { theme, isOverridden, isAdaptive, setThemeOverride, setAdaptive, themes } = useTheme();
  const user = useAuthStore((s) => s.user);

  const currentThemeConfig = themes.find((t) => t.name === theme);

  return (
    <div className="settings-page">
      <section className="settings-section panel">
        <h2>Appearance</h2>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Adaptive theme</span>
            <span className="setting-desc">Changes theme automatically based on time of day</span>
          </div>
          <label className="toggle-switch" aria-label="Toggle adaptive theme">
            <input
              type="checkbox"
              checked={isAdaptive}
              onChange={(e) => setAdaptive(e.target.checked)}
            />
            <span className="toggle-track">
              <span className="toggle-thumb" />
            </span>
          </label>
        </div>

        <hr className="setting-divider" />

        {isOverridden && (
          <div className="setting-override-banner" role="status">
            <span>
              {currentThemeConfig?.emoji} Theme manually set to <strong>{currentThemeConfig?.label}</strong>
            </span>
            <button type="button" className="ghost-btn btn-sm" onClick={() => setThemeOverride(null)}>
              Reset to auto
            </button>
          </div>
        )}

        <div className="theme-card-grid" role="group" aria-label="Select theme">
          {themes.map((themeConfig) => {
            const isActive = theme === themeConfig.name;

            return (
              <button
                key={themeConfig.name}
                type="button"
                className={`theme-card${isActive ? ' theme-card--active' : ''}`}
                style={{ '--theme-dot-color': themeConfig.dotColor } as CSSProperties}
                onClick={() => {
                  if (isOverridden && isActive) {
                    setThemeOverride(null);
                  } else {
                    setThemeOverride(themeConfig.name);
                  }
                }}
                aria-pressed={isActive}
              >
                <span className="theme-card-dot" aria-hidden="true" />
                <span className="theme-card-emoji" aria-hidden="true">
                  {themeConfig.emoji}
                </span>
                <span className="theme-card-label">{themeConfig.label}</span>
                <span className="theme-card-time">{themeConfig.timeRange}</span>
              </button>
            );
          })}
        </div>

        <p className="setting-status">
          {isOverridden
            ? `Using ${currentThemeConfig?.label} theme (manually set)`
            : isAdaptive
              ? `Using ${currentThemeConfig?.label} theme (adaptive)`
              : `Using ${currentThemeConfig?.label} theme (adaptive off)`}
        </p>
      </section>

      <section className="settings-section panel">
        <h2>Account</h2>

        <div className="setting-row">
          <span className="setting-label">Name</span>
          <span className="setting-value">{user?.name ?? '—'}</span>
        </div>

        <hr className="setting-divider" />

        <div className="setting-row">
          <span className="setting-label">Email</span>
          <span className="setting-value">{user?.email ?? '—'}</span>
        </div>

        <hr className="setting-divider" />

        <div className="setting-row">
          <span className="setting-label">Password</span>
          <button type="button" className="ghost-btn btn-sm" onClick={() => navigate('/forgot-password')}>
            Change password
          </button>
        </div>
      </section>
    </div>
  );
}
