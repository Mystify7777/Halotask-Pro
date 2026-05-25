import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
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

type ColdStartOverlayProps = {
  active: boolean;
  onExited: () => void;
};

const EMOJIS = ['✅', '📋', '⭐', '🎯', '🌱', '🚀', '💡', '🔥', '🎉'];
const SPAWN_INTERVAL_MS = 900;
const BUBBLE_MIN_DURATION = 2800;
const BUBBLE_MAX_EXTRA = 1600;

export default function ColdStartOverlay({ active, onExited }: ColdStartOverlayProps) {
  const [bubbles, setBubbles] = useState<Bubble[]>([]);
  const [sparks, setSparks] = useState<Spark[]>([]);
  const [score, setScore] = useState(0);
  const [phase, setPhase] = useState<'entering' | 'active' | 'ready' | 'exiting'>('entering');
  const [dots, setDots] = useState('');
  const nextIdRef = useRef(0);
  const spawnIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    const enterTimer = window.setTimeout(() => setPhase('active'), 400);

    spawnBubble();
    spawnIntervalRef.current = window.setInterval(spawnBubble, SPAWN_INTERVAL_MS);

    return () => {
      window.clearTimeout(enterTimer);
      if (spawnIntervalRef.current) {
        window.clearInterval(spawnIntervalRef.current);
      }
    };
  }, [spawnBubble]);

  useEffect(() => {
    if (active || phase !== 'active') {
      return;
    }

    if (spawnIntervalRef.current) {
      window.clearInterval(spawnIntervalRef.current);
      spawnIntervalRef.current = null;
    }

    setPhase('ready');

    const readyTimer = window.setTimeout(() => {
      setPhase('exiting');
    }, 900);

    return () => window.clearTimeout(readyTimer);
  }, [active, phase]);

  useEffect(() => {
    if (phase !== 'exiting') {
      return;
    }

    const exitTimer = window.setTimeout(onExited, 500);
    return () => window.clearTimeout(exitTimer);
  }, [onExited, phase]);

  useEffect(() => {
    if (phase === 'ready' || phase === 'exiting') {
      setDots('');
      return;
    }

    const dotsTimer = window.setInterval(() => {
      setDots((current) => (current.length >= 3 ? '' : `${current}.`));
    }, 420);

    return () => window.clearInterval(dotsTimer);
  }, [phase]);

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

  return (
    <div className={overlayClassName} role="dialog" aria-modal="true" aria-label="Server loading">
      <div className={styles.atmosphere}>
        {Array.from({ length: 24 }, (_, index) => (
          <span key={index} className={styles.star} style={{ '--i': index } as CSSProperties} />
        ))}
      </div>

      <div className={styles.header}>
        {phase === 'ready' || phase === 'exiting' ? (
          <p className={styles.readyBadge}>🎉 Server is ready!</p>
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