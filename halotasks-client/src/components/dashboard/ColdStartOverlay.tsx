import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';
import styles from './ColdStartOverlay.module.css';

type Bubble = {
  id: number;
  emoji: string;
  x: number;
  duration: number;
  size: number;
};

type Spark = {
  id: number;
  x: number;
  y: number;
};

export type ColdStartOutcome = 'waking' | 'ready' | 'error';

type ColdStartOverlayProps = {
  /**
   * 'waking' — backend hasn't responded yet, keep the tapper running.
   * 'ready'  — the backend genuinely responded successfully; play the
   *            celebratory close.
   * 'error'  — the wait ended without success; close quietly and never
   *            claim the backend is ready.
   */
  outcome: ColdStartOutcome;
  /** Called once the overlay has finished its own exit animation. */
  onExited: () => void;
  /**
   * Called when the user explicitly dismisses the overlay early. Distinct
   * from onExited so the dashboard can tell "closed by us" apart from
   * "closed by the user before we were ready" if it ever needs to.
   */
  onDismiss: () => void;
};

const EMOJIS = ['✅', '📋', '⭐', '🎯', '🌱', '🚀', '💡', '🔥', '🎉'];
const SPAWN_INTERVAL_MS = 900;
const BUBBLE_MIN_DURATION = 2800;
const BUBBLE_MAX_EXTRA = 1600;

export default function ColdStartOverlay({ outcome, onExited, onDismiss }: ColdStartOverlayProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<'entering' | 'active' | 'ready' | 'closing' | 'exiting'>('entering');
  const [dots, setDots] = useState('');
  const nextIdRef = useRef(0);
  const spawnIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const dismissedRef = useRef(false);

  const spawnBubble = useCallback(() => {
    const id = nextIdRef.current++;
    const duration = BUBBLE_MIN_DURATION + Math.random() * BUBBLE_MAX_EXTRA;
    const bubble: Bubble = {
      id,
      emoji: EMOJIS[Math.floor(Math.random() * EMOJIS.length)],
      x: 4 + Math.random() * 82,
      duration,
      size: 46 + Math.floor(Math.random() * 22),
    };

    setBubbles((current) => [...current, bubble]);

    window.setTimeout(() => {
      setBubbles((current) => current.filter((item) => item.id !== id));
    }, duration + 200);
  }, []);

  useEffect(() => {
    overlayRef.current?.focus();
  }, []);

  useEffect(() => {
    const enterTimer = window.setTimeout(() => {
      // Guard against a manual dismiss (or a fast ready/error outcome) that
      // already moved the phase on before this fires.
      setPhase((current) => (current === 'entering' ? 'active' : current));
    }, 400);

    spawnBubble();
    spawnIntervalRef.current = window.setInterval(spawnBubble, SPAWN_INTERVAL_MS);

    return () => {
      window.clearTimeout(enterTimer);
      if (spawnIntervalRef.current) {
        window.clearInterval(spawnIntervalRef.current);
      }
    };
  }, [spawnBubble]);

  // Step 1: once we're past the entrance animation, react to a *genuine*
  // outcome from the caller. This only ever fires once per wait — it's
  // guarded to phase === 'active' so it can't re-trigger itself after it
  // moves the phase on to 'ready' / 'closing'.
  useEffect(() => {
    if (dismissedRef.current || outcome === 'waking' || phase !== 'active') {
      return;
    }

    if (spawnIntervalRef.current) {
      window.clearInterval(spawnIntervalRef.current);
      spawnIntervalRef.current = null;
    }

    setPhase(outcome === 'ready' ? 'ready' : 'closing');
  }, [outcome, phase]);

  // Step 2a: a genuine "ready" outcome gets a brief celebratory beat before
  // exiting.
  useEffect(() => {
    if (phase !== 'ready') {
      return;
    }

    const readyTimer = window.setTimeout(() => setPhase('exiting'), 900);
    return () => window.clearTimeout(readyTimer);
  }, [phase]);

  // Step 2b: an "error" outcome (or an interrupted/reset cycle) closes
  // quietly and quickly — it must never pass through the "ready" state.
  useEffect(() => {
    if (phase !== 'closing') {
      return;
    }

    const closingTimer = window.setTimeout(() => setPhase('exiting'), 300);
    return () => window.clearTimeout(closingTimer);
  }, [phase]);

  useEffect(() => {
    if (phase !== 'exiting') {
      return;
    }

    const exitTimer = window.setTimeout(() => {
      if (dismissedRef.current) {
        onDismiss();
      } else {
        onExited();
      }
    }, 500);
    return () => window.clearTimeout(exitTimer);
  }, [onDismiss, onExited, phase]);

  useEffect(() => {
    if (phase === 'ready' || phase === 'closing' || phase === 'exiting') {
      setDots('');
      return;
    }

    const dotsTimer = window.setInterval(() => {
      setDots((current) => (current.length >= 3 ? '' : `${current}.`));
    }, 420);

    return () => window.clearInterval(dotsTimer);
  }, [phase]);

  // Manual dismissal is only offered while we're still waking — once the
  // backend has genuinely answered, the automatic close takes over instead.
  const handleManualDismiss = () => {
    if (phase === 'ready' || phase === 'closing' || phase === 'exiting') {
      return;
    }

    dismissedRef.current = true;

    if (spawnIntervalRef.current) {
      window.clearInterval(spawnIntervalRef.current);
      spawnIntervalRef.current = null;
    }

    setPhase('exiting');
  };

  const handleOverlayKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      handleManualDismiss();
    }
  };

  const tapBubble = (
    bubbleId: number,
    event: PointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    setScore((current) => current + 1);
    setBubbles((current) => current.filter((bubble) => bubble.id !== bubbleId));

    const rect = event.currentTarget.getBoundingClientRect();
    const sparkId = nextIdRef.current++;

    setSparks((current) => [
      ...current,
      {
        id: sparkId,
        x: rect.left + rect.width / 2,
        y: rect.top,
      },
    ]);

    window.setTimeout(() => {
      setSparks((current) => current.filter((spark) => spark.id !== sparkId));
    }, 700);
  };

  const overlayClassName = [
    styles.overlay,
    phase === 'entering' ? styles.entering : '',
    phase === 'ready' ? styles.ready : '',
    phase === 'exiting' ? styles.exiting : '',
  ]
    .filter(Boolean)
    .join(' ');

  const canDismiss = phase === 'entering' || phase === 'active';

  return (
    <div
      ref={overlayRef}
      className={overlayClassName}
      role="dialog"
      aria-modal="true"
      aria-label="Server loading"
      tabIndex={-1}
      onKeyDown={handleOverlayKeyDown}
    >
      {canDismiss && (
        <button
          type="button"
          className={styles.closeButton}
          onClick={handleManualDismiss}
          aria-label="Close server loading screen and continue"
        >
          <span aria-hidden="true">✕</span>
        </button>
      )}

      <div className={styles.atmosphere}>
        {Array.from({ length: 24 }, (_, index) => (
          <span key={index} className={styles.star} style={{ '--i': index } as CSSProperties} />
        ))}
      </div>

      <div className={styles.header}>
        {phase === 'ready' ? (
          <p className={styles.readyBadge}>🎉 Server is ready!</p>
        ) : phase === 'closing' || phase === 'exiting' ? (
          <p className={styles.statusLine}>Continuing…</p>
        ) : (
          <>
            <p className={styles.statusLine}>
              <span className={styles.pulsingDot} />
              Waking up the server{dots}
            </p>
            <p className={styles.hint}>Task Tapper: tap the bubbles while you wait.</p>
          </>
        )}
      </div>

      <div className={styles.scoreBoard}>
        <span className={styles.scoreLabel}>Score</span>
        <span className={styles.scoreValue}>{score}</span>
      </div>

      <div className={styles.arena} aria-hidden="true">
        {bubbles.map((bubble) => (
          <button
            key={bubble.id}
            type="button"
            className={styles.bubble}
            style={{
              left: `${bubble.x}%`,
              width: bubble.size,
              height: bubble.size,
              fontSize: bubble.size * 0.52,
              animationDuration: `${bubble.duration}ms`,
            } as CSSProperties}
            onPointerUp={(event) => tapBubble(bubble.id, event)}
            aria-label={`Tap ${bubble.emoji}`}
          >
            {bubble.emoji}
          </button>
        ))}
      </div>

      {sparks.map((spark) => (
        <div key={spark.id} className={styles.spark} style={{ left: spark.x, top: spark.y } as CSSProperties}>
          +1
        </div>
      ))}
    </div>
  );
}
