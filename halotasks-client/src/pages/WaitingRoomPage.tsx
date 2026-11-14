import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import ColdStartOverlay from '../components/dashboard/ColdStartOverlay';
import { useLaunch } from '../launch/launchContext';
import type { UnavailableCause } from '../launch/launchState';
import { useAuthStore } from '../store/authStore';
import styles from './AuthPages.module.css';

const COPY: Record<UnavailableCause, { title: string; body: string }> = {
  'browser-offline': {
    title: "You're offline",
    body: "We can't confirm your sign-in without a connection, so your tasks stay hidden for now. We'll carry on as soon as you're back online.",
  },
  waking: {
    title: 'Server is waking up',
    body: "We're getting things ready. We can't confirm your sign-in until the server is awake, so your tasks stay hidden for now. This usually takes under a minute, and we'll keep checking for you.",
  },
  timeout: {
    title: "We can't reach the server",
    body: "We can't confirm your sign-in until the server is back, so your tasks stay hidden for now. We'll keep checking automatically.",
  },
  unhealthy: {
    title: 'The server is having trouble',
    body: "We can't confirm your sign-in until the server recovers, so your tasks stay hidden for now. We'll keep checking automatically.",
  },
};

/**
 * The one place an unverified session may go while the server is unavailable (`access: 'waiting-room'`, Issue #49).
 * It renders nothing protected and works out nothing by itself: what it says comes from the launch decision, and the
 * automatic re-checks are the shared readiness probe's (growing gaps, then a slow background re-check). The visible
 * "Check now" asks that same probe again. "Play while you wait" opens the existing Task Tapper, which is data-free.
 * When the server answers, the decision moves on (a session the server cannot confirm goes to sign-in) and this page
 * unmounts by itself; no reload is involved.
 */
export default function WaitingRoomPage() {
  const { decision, readiness } = useLaunch();
  const navigate = useNavigate();
  const clearAuth = useAuthStore((s) => s.clearAuth);
  const [playing, setPlaying] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const playRef = useRef<HTMLButtonElement>(null);
  const wasPlaying = useRef(false);
  useEffect(() => headingRef.current?.focus(), []);
  // When the game closes, focus goes back to the button that opened it (the dialog's unmount would drop it on <body>).
  useEffect(() => {
    if (wasPlaying.current && !playing) playRef.current?.focus();
    wasPlaying.current = playing;
  }, [playing]);

  const copy = COPY[decision.unavailable ?? 'timeout'];
  const offline = decision.unavailable === 'browser-offline';

  const signOut = () => {
    clearAuth();
    navigate('/login', { replace: true });
  };

  return (
    <main className={styles.page}>
      <header className={styles.authHeader}>
        <div className={styles.authLogoRow}>
          <span className={styles.authLogoEmoji} aria-hidden="true">
            🌱
          </span>
          <span className={styles.authLogoText}>halotask</span>
        </div>
      </header>

      <section className={styles.card} aria-label="Waiting for the server">
        <div className={styles.cardTop}>
          <h1 className={`${styles.cardTitle} ${styles.focusTarget}`} ref={headingRef} tabIndex={-1}>
            {copy.title}
          </h1>
          <p className={styles.cardSub}>{copy.body}</p>
        </div>

        <p role="status" className={styles.cardSub}>
          {offline ? 'Waiting for your connection…' : 'Checking again automatically…'}
        </p>

        <div className="auth-cta-stack">
          {!offline && (
            <button type="button" className="btn-primary" onClick={readiness.retry}>
              Check now
            </button>
          )}
          <button type="button" className="btn-secondary" ref={playRef} onClick={() => setPlaying(true)} disabled={playing}>
            Play while you wait
          </button>
          <button type="button" className="btn-secondary" onClick={signOut}>
            Sign out
          </button>
        </div>
      </section>

      {playing && <ColdStartOverlay outcome="waking" onExited={() => setPlaying(false)} onDismiss={() => setPlaying(false)} />}
    </main>
  );
}
