import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';
import { markOnboardingDone } from '../utils/authSession';
import './OnboardingPage.css';

function TreeIllo() {
  return (
    <svg viewBox="0 0 120 130" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" className="ob-tree-wrap">
      <rect x="54" y="95" width="12" height="28" rx="6" fill="#A1887F" />
      <ellipse cx="60" cy="82" rx="34" ry="30" fill="#66BB6A" />
      <ellipse cx="38" cy="88" rx="22" ry="20" fill="#81C784" />
      <ellipse cx="82" cy="88" rx="22" ry="20" fill="#81C784" />
      <ellipse cx="60" cy="60" rx="28" ry="26" fill="#A5D6A7" />
      <ellipse cx="60" cy="44" rx="20" ry="19" fill="#C8E6C9" />
      <circle cx="72" cy="72" r="5" fill="var(--color-primary)" opacity="0.85" />
      <circle cx="48" cy="80" r="4" fill="var(--color-primary)" opacity="0.85" />
      <circle cx="63" cy="88" r="4" fill="#FFCC02" opacity="0.9" />
      <circle cx="52" cy="60" r="3" fill="var(--color-primary)" opacity="0.7" />
    </svg>
  );
}

const CONFETTI_COLORS = ['var(--color-primary)', '#66BB6A', '#FFCC02', '#FF8A65', '#5C6BC0', '#26C6DA'];

function Confetti() {
  const dots = useMemo(
    () =>
      Array.from({ length: 22 }, (_, i) => ({
        id: i,
        left: `${Math.random() * 100}%`,
        color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        delay: `${Math.random() * 0.6}s`,
        dur: `${1.4 + Math.random() * 0.8}s`,
      })),
    [],
  );

  return (
    <div className="ob-confetti" aria-hidden="true">
      {dots.map((dot) => (
        <span
          key={dot.id}
          className="ob-confetti-dot"
          style={{
            left: dot.left,
            top: '-10px',
            background: dot.color,
            animationDelay: dot.delay,
            animationDuration: dot.dur,
          }}
        />
      ))}
    </div>
  );
}

type NotifState = 'idle' | 'requesting' | 'granted' | 'denied';

function StepWelcome({ name }: { name: string }) {
  return (
    <>
      <div className="ob-illo">
        <span className="ob-seed" role="img" aria-label="seedling">
          🌱
        </span>
      </div>

      <div className="ob-text">
        <h1 className="ob-title">
          Welcome,
          <br />
          {name || 'there'} 👋
        </h1>
        <p className="ob-sub">HaloTasks is a task manager that grows with you — literally. Let's take a 30-second tour.</p>
      </div>

      <div className="ob-chips">
        <span className="ob-chip">🎨 Adaptive themes</span>
        <span className="ob-chip">🌳 Growth tree</span>
        <span className="ob-chip">✨ AI creation</span>
      </div>
    </>
  );
}

function StepTree() {
  return (
    <>
      <div className="ob-illo">
        <TreeIllo />
      </div>

      <div className="ob-text">
        <h1 className="ob-title">Complete tasks,<br />grow your tree</h1>
        <p className="ob-sub">Every task you finish earns XP. Watch your tree evolve through five stages as your productivity blooms.</p>
      </div>

      <div className="ob-xp-bar" role="presentation">
        <div className="ob-xp-label">
          <span>Sprout</span>
          <span>35 / 100 XP</span>
        </div>
        <div className="ob-xp-track">
          <div className="ob-xp-fill" />
        </div>
      </div>

      <div className="ob-stages" role="list" aria-label="Tree stages">
        {['🌰 Seed', '🌱 Sprout', '🌿 Young', '🌲 Mature', '🌳 Lush'].map((stage, index) => (
          <span key={stage} className={`ob-stage${index === 1 ? ' ob-stage--active' : ''}`} role="listitem">
            {stage}
          </span>
        ))}
      </div>
    </>
  );
}

function StepTasks() {
  return (
    <>
      <div className="ob-mock-card">
        <div className="ob-mock-row">
          <span className="ob-mock-check" aria-hidden="true" />
          <span className="ob-mock-title">Review quarterly report</span>
          <span className="ob-mock-badge">High</span>
        </div>
        <div className="ob-mock-row">
          <span className="ob-mock-check" aria-hidden="true" />
          <span className="ob-mock-title">Call dentist — next Tuesday</span>
          <span className="ob-mock-badge">Med</span>
        </div>
        <div className="ob-mock-ai-hint">
          <span aria-hidden="true">✨</span>
          <span>
            Tap <strong>✨</strong> beside the title to create tasks with AI
          </span>
        </div>
      </div>

      <div className="ob-text">
        <h1 className="ob-title">Add tasks<br />your way</h1>
        <p className="ob-sub">Use the <strong>+</strong> button to create tasks one at a time, or describe several in plain English and let AI parse them instantly.</p>
      </div>
    </>
  );
}

function StepReminders({ notifState, onRequest }: { notifState: NotifState; onRequest: () => void }) {
  const granted = notifState === 'granted';
  const denied = notifState === 'denied';

  return (
    <>
      <div className="ob-illo">
        <span className={`ob-bell${granted ? ' ob-bell--granted' : ''}`} role="img" aria-label="bell">
          {granted ? '✅' : '🔔'}
        </span>
      </div>

      <div className="ob-text">
        <h1 className="ob-title">Never miss<br />a deadline</h1>
        <p className="ob-sub">
          {denied
            ? 'Notifications were blocked. You can enable them later in your browser settings or from the Reminders page.'
            : granted
              ? "Notifications are enabled. You'll be reminded before tasks are due, even on other devices."
              : 'Get notified before tasks are due — on this device and anywhere else you install HaloTasks.'}
        </p>
      </div>

      {granted && (
        <div className="ob-granted-banner" role="status">
          <span aria-hidden="true">✅</span> Notifications enabled!
        </div>
      )}

      {!granted && !denied && (
        <button type="button" className="ob-btn-primary" onClick={onRequest} disabled={notifState === 'requesting'} style={{ maxWidth: 320 }}>
          {notifState === 'requesting' ? 'Requesting…' : '🔔 Enable Notifications'}
        </button>
      )}
    </>
  );
}

function StepReady({ notifGranted }: { notifGranted: boolean }) {
  return (
    <>
      <div className="ob-illo" style={{ position: 'relative' }}>
        <Confetti />
        <span className="ob-ready-emoji" role="img" aria-label="rocket">
          🚀
        </span>
      </div>

      <div className="ob-text">
        <h1 className="ob-title">You're all set!</h1>
        <p className="ob-sub">Here's what's waiting for you:</p>
      </div>

      <ul className="ob-checklist" aria-label="Feature summary">
        <li className="ob-check-item">
          <span className="ob-check-icon" aria-hidden="true">🌳</span>
          A seed waiting to grow into your productivity tree
        </li>
        <li className="ob-check-item">
          <span className="ob-check-icon" aria-hidden="true">✨</span>
          AI task creation to turn any idea into structured tasks
        </li>
        <li className="ob-check-item">
          <span className="ob-check-icon" aria-hidden="true">{notifGranted ? '🔔' : '⚙️'}</span>
          {notifGranted ? 'Deadline reminders across all your devices' : 'Reminders ready to enable anytime from Settings'}
        </li>
      </ul>
    </>
  );
}

const STEP_COUNT = 5;

export default function OnboardingPage() {
  const navigate = useNavigate();
  const user = useAuthStore((state) => state.user);
  const [step, setStep] = useState(0);
  const [goingBack, setGoingBack] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const [notifState, setNotifState] = useState<NotifState>('idle');

  useEffect(() => {
    if ('Notification' in window && Notification.permission === 'granted') {
      setNotifState('granted');
    } else if ('Notification' in window && Notification.permission === 'denied') {
      setNotifState('denied');
    }
  }, []);

  const advance = useCallback((back = false) => {
    setGoingBack(back);
    setAnimKey((current) => current + 1);
  }, []);

  const goNext = useCallback(() => {
    if (step === STEP_COUNT - 1) {
      markOnboardingDone();
      navigate('/dashboard', { replace: true });
      return;
    }

    advance(false);
    setStep((current) => current + 1);
  }, [advance, navigate, step]);

  const goBack = useCallback(() => {
    if (step === 0) {
      return;
    }

    advance(true);
    setStep((current) => current - 1);
  }, [advance, step]);

  const requestNotifications = useCallback(async () => {
    if (!('Notification' in window)) {
      setNotifState('denied');
      return;
    }

    setNotifState('requesting');
    try {
      const permission = await Notification.requestPermission();
      setNotifState(permission === 'granted' ? 'granted' : 'denied');
    } catch {
      setNotifState('denied');
    }
  }, []);

  const ctaLabel =
    step === STEP_COUNT - 1
      ? "Let's go! →"
      : step === 3 && notifState === 'idle'
        ? 'Skip for now →'
        : 'Continue →';

  const showSkipLink = step === 3 && notifState === 'idle';

  return (
    <div className="ob-page">
      <div className="ob-progress" role="progressbar" aria-valuenow={step + 1} aria-valuemax={STEP_COUNT}>
        {Array.from({ length: STEP_COUNT }, (_, index) => (
          <span key={index} className={`ob-dot${index <= step ? ' ob-dot--active' : ''}`} />
        ))}
      </div>

      <div className="ob-viewport">
        <div key={animKey} className={`ob-step${goingBack ? ' ob-step--back' : ''}`}>
          {step === 0 && <StepWelcome name={user?.name?.split(' ')[0] ?? ''} />}
          {step === 1 && <StepTree />}
          {step === 2 && <StepTasks />}
          {step === 3 && <StepReminders notifState={notifState} onRequest={requestNotifications} />}
          {step === 4 && <StepReady notifGranted={notifState === 'granted'} />}
        </div>
      </div>

      <nav className="ob-nav" aria-label="Onboarding navigation">
        {!(step === 3 && notifState === 'idle') && (
          <button type="button" className="ob-btn-primary" onClick={goNext}>
            {ctaLabel}
          </button>
        )}

        {showSkipLink && (
          <button type="button" className="ob-btn-ghost" onClick={goNext}>
            Skip for now →
          </button>
        )}

        {step === 3 && notifState !== 'idle' && notifState !== 'requesting' && (
          <button type="button" className="ob-btn-primary" onClick={goNext}>
            Continue →
          </button>
        )}

        {step > 0 && (
          <button type="button" className="ob-btn-back" onClick={goBack}>
            ← Back
          </button>
        )}
      </nav>
    </div>
  );
}