import { useEffect, useRef } from 'react';
import styles from './AuthPages.module.css';

/**
 * Shown while the launch cannot yet say whether this session may see the app AND the server has not answered
 * (`access: 'hold'`, Issue #49). Nothing protected renders and nothing alarming is said: it is the first seconds of a
 * normal start. It cannot last: the readiness probe either answers (the decision moves on) or fails (the waiting room).
 */
export default function LaunchHoldPage() {
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

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

      <section className={styles.card} aria-label="Checking your session">
        <div className={styles.cardTop}>
          <h1 className={`${styles.cardTitle} ${styles.focusTarget}`} ref={headingRef} tabIndex={-1}>
            Getting things ready
          </h1>
          <p className={styles.cardSub} role="status">
            Checking your session…
          </p>
        </div>
      </section>
    </main>
  );
}
