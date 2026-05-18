import { useEffect, useRef } from 'react';
import { Task } from '../../types/task';

const PRIORITY_DOT: Record<string, string> = {
  high:   'var(--color-danger-border)',
  medium: 'var(--color-warning-border)',
  low:    'var(--color-info-border)',
};

const formatMins = (mins: number): string =>
  mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;

type InsightModalProps = {
  isOpen: boolean;
  title: string;
  tasks: Task[];
  emptyMessage: string;
  onClose: () => void;
  onToggleTask: (task: Task) => void;
};

export default function InsightModal({
  isOpen,
  title,
  tasks,
  emptyMessage,
  onClose,
  onToggleTask,
}: InsightModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Focus panel on open
  useEffect(() => {
    if (isOpen) panelRef.current?.focus();
  }, [isOpen]);

  // Lock scroll on mobile only
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    if (!isMobile || !isOpen) return;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <div className="sheet-backdrop" aria-hidden="true" onClick={onClose} />

      <div
        ref={panelRef}
        className="insight-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        {/* Handle — mobile only visual */}
        <div className="sheet-handle" aria-hidden="true" />

        {/* Header */}
        <div className="sheet-header">
          <h2 className="sheet-title">{title}</h2>
          <button
            type="button"
            className="ghost-btn sheet-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Task list */}
        <div className="insight-modal-body">
          {tasks.length === 0 ? (
            <p className="insight-modal-empty">{emptyMessage}</p>
          ) : (
            <ul className="insight-modal-list" aria-label={`${tasks.length} tasks`}>
              {tasks.map((task) => (
                <li key={task._id} className={`insight-modal-task${task.completed ? ' completed' : ''}`}>
                  {/* Complete toggle */}
                  <button
                    type="button"
                    className={`insight-modal-toggle${task.completed ? ' checked' : ''}`}
                    onClick={() => onToggleTask(task)}
                    aria-label={
                      task.completed
                        ? `Mark "${task.title}" incomplete`
                        : `Mark "${task.title}" complete`
                    }
                  >
                    {task.completed && <span aria-hidden="true">✓</span>}
                  </button>

                  {/* Title */}
                  <span className={`insight-modal-title${task.completed ? ' completed' : ''}`}>
                    {task.title}
                  </span>

                  {/* Meta: priority + time */}
                  <span className="insight-modal-meta">
                    <span
                      className="insight-modal-priority-dot"
                      style={{ background: PRIORITY_DOT[task.priority] }}
                      aria-label={`${task.priority} priority`}
                    />
                    {task.estimatedMinutes > 0 && (
                      <span className="insight-modal-time">
                        {formatMins(task.estimatedMinutes)}
                      </span>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </>
  );
}
