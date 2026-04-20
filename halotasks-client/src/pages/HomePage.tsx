import { Link } from 'react-router-dom';

export default function HomePage() {
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
        </article>

        <div className="auth-card">
          <h2>Get Started</h2>
          <p>Use HaloTaskPro as your reliable daily command center.</p>

          <div className="auth-cta-stack">
            <Link className="cta-link" to="/register">
              Create Free Workspace
            </Link>
            <Link className="ghost-btn auth-ghost-link" to="/login">
              I already have an account
            </Link>
          </div>

          <p className="auth-link">No spam, no setup ceremony, just focused execution.</p>
        </div>
      </div>
    </section>
  );
}
