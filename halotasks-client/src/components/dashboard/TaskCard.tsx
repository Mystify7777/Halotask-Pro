import { useRef, useState } from 'react';
import { Task } from '../../types/task';
import { getDateBadgeClass } from '../../utils/dateHelpers';
import { formatDueLabel, formatStartLabel } from '../../utils/deadline';
import { getSubtasks, subtaskProgress } from '../../utils/subtasks';
import { normalizeTag } from '../../utils/tagHelpers';
import styles from './TaskCard.module.css';

type TaskCardProps = {
  task:               Task;
  activeActionTaskId: string | null;
  tagFilter:          string | null;
  isSelected:         boolean;
  /** True while at least one task is selected: every card then shows its select checkbox. */
  selectionMode?:     boolean;
  bulkActionLoading:  boolean;
  onToggleTask:       (task: Task) => void;
  onToggleSubtask:    (taskId: string, subtaskId: string) => void;
  onDeleteTask:       (taskId: string) => void;
  onStartEditing:     (task: Task) => void;
  onToggleTagFilter:  (tag: string) => void;
  onToggleSelect:     (taskId: string) => void;
};

const PRIORITY_DOT: Record<string, string> = {
  high: 'high',
  medium: 'med',
  low: 'low',
};

const PRIORITY_LABEL: Record<string, string> = {
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_PX = 10;
// Android fires a contextmenu event after a long press, iOS does not: both paths select, but only once.
const SELECT_DEDUPE_MS = 800;

function PencilIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 6h18" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

export default function TaskCard({
  task,
  activeActionTaskId,
  tagFilter,
  isSelected,
  selectionMode = false,
  bulkActionLoading,
  onToggleTask,
  onToggleSubtask,
  onDeleteTask,
  onStartEditing,
  onToggleTagFilter,
  onToggleSelect,
}: TaskCardProps) {
  const isActioning = activeActionTaskId === task._id;
  const isDisabled = isActioning || bulkActionLoading;
  const dueLabel = formatDueLabel(task);
  const startLabel = formatStartLabel(task.startTime);
  const dueClass = getDateBadgeClass(task.dueDate, task.dueTime);
  const dotClass = PRIORITY_DOT[task.priority] ?? 'low';

  // Presentation state only: collapsed by default, not persisted, never part of the task.
  const [expanded, setExpanded] = useState(false);
  // The title is cut with an ellipsis so every card stays the same width and height class; clicking the card shows it in full.
  const [titleOpen, setTitleOpen] = useState(false);
  const subtasks = getSubtasks(task);
  const { done, total } = subtaskProgress(task);
  const description = task.description?.trim() ? task.description : '';
  const hasDetails = total > 0 || description !== '';
  const titleId = `${task._id}-title`;
  const detailsId = `${task._id}-details`;

  // Selecting without a visible checkbox: right-click (or long-press on touch) on the card. The checkbox itself appears
  // once something is selected, and for keyboard users when it takes focus (it stays in the tab order).
  const lastSelectAt = useRef(0);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressStart = useRef<{ x: number; y: number } | null>(null);
  const swallowNextClick = useRef(false);
  const selectFromGesture = () => {
    const now = Date.now();
    if (isDisabled || now - lastSelectAt.current < SELECT_DEDUPE_MS) return;
    lastSelectAt.current = now;
    onToggleSelect(task._id);
  };
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
    pressStart.current = null;
  };

  return (
    // The list item around this card already draws the card (border, background, padding); this is only its content row.
    <div
      className={`${styles.card} ${styles.noCallout}${hasDetails && expanded ? ` ${styles.cardExpanded}` : ''}`}
      onContextMenu={(event) => {
        // Keep the browser's own menu for text fields and links.
        if ((event.target as HTMLElement).closest('input, textarea, a')) return;
        event.preventDefault();
        selectFromGesture();
      }}
      onPointerDown={(event) => {
        if (event.pointerType !== 'touch' || (event.target as HTMLElement).closest('input, textarea, a')) return;
        cancelPress();
        pressStart.current = { x: event.clientX, y: event.clientY };
        pressTimer.current = setTimeout(() => {
          pressTimer.current = null;
          swallowNextClick.current = true;
          selectFromGesture();
        }, LONG_PRESS_MS);
      }}
      onPointerMove={(event) => {
        const start = pressStart.current;
        if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > LONG_PRESS_MOVE_PX) cancelPress();
      }}
      onPointerUp={cancelPress}
      onPointerCancel={cancelPress}
      onClickCapture={(event) => {
        // The click that ends a long press must not also toggle the title, the checkbox or a button under the finger.
        if (swallowNextClick.current) {
          swallowNextClick.current = false;
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        // A click on blank card area toggles the full title; clicks on any control keep doing only their own job.
        if ((event.target as HTMLElement).closest('button, input, a, label, [role="checkbox"], [role="region"]')) return;
        setTitleOpen((current) => !current);
      }}
    >
      <span
        role="checkbox"
        aria-checked={task.completed}
        aria-label={`Mark "${task.title}" as ${task.completed ? 'incomplete' : 'complete'}`}
        tabIndex={isDisabled ? -1 : 0}
        className={`task-check ${task.completed ? 'checked' : ''} ${styles.check}`}
        onClick={() => !isDisabled && onToggleTask(task)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault(); // Space would otherwise scroll the page
          if (!isDisabled) onToggleTask(task);
        }}
        aria-disabled={isDisabled}
      >
        {task.completed && !isActioning && (
          <svg width="11" height="8" viewBox="0 0 11 8" fill="none" aria-hidden="true">
            <path d="M1 4L4 7L10 1" stroke="white" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        {isActioning && <span className={styles.spinner} aria-hidden="true" />}
      </span>

      <div className={styles.info}>
        <button
          type="button"
          className={styles.titleButton}
          aria-expanded={titleOpen}
          onClick={() => setTitleOpen((current) => !current)}
        >
          <strong id={titleId} className={`${styles.title} ${titleOpen ? styles.titleOpen : ''}`}>{task.title}</strong>
        </button>

        <div className={styles.meta}>
          <span className={styles.priorityWrap}>
            <span className={`priority-dot ${dotClass}`} aria-hidden="true" />
            <span className={styles.priorityLabel}>{PRIORITY_LABEL[task.priority] ?? task.priority}</span>
          </span>

          {dueLabel && <span className={`${dueClass} ${styles.metaItem}`}>{dueLabel}</span>}
          {startLabel && <span className={`date-muted ${styles.metaItem}`}>{startLabel}</span>}

          {task.estimatedMinutes > 0 && (
            <span className={styles.metaItem}>
              ⏱ {task.estimatedMinutes < 60
                ? `${task.estimatedMinutes}m`
                : `${Math.floor(task.estimatedMinutes / 60)}h${task.estimatedMinutes % 60 > 0 ? ` ${task.estimatedMinutes % 60}m` : ''}`}
            </span>
          )}

          {total > 0 && (
            <span
              className={styles.progress}
              role="progressbar"
              aria-label={`Subtasks completed for "${task.title}"`}
              aria-valuemin={0}
              aria-valuemax={total}
              aria-valuenow={done}
              aria-valuetext={`${done} of ${total} subtasks completed`}
            >
              <span className={styles.progressText}>{done}/{total}</span>
              <span className={styles.progressTrack} aria-hidden="true">
                <span className={styles.progressFill} style={{ width: `${(done / total) * 100}%` }} />
              </span>
            </span>
          )}

          {task.pendingSync && <span className="task-pending-sync">⟳ Syncing</span>}
        </div>

        {hasDetails && (
          <button
            type="button"
            className={styles.disclosure}
            aria-expanded={expanded}
            aria-controls={detailsId}
            aria-label={`${expanded ? 'Hide' : 'Show'} subtasks and description for "${task.title}"`}
            onClick={() => setExpanded((current) => !current)}
          >
            <span aria-hidden="true">{expanded ? '▾' : '▸'}</span>
            <span aria-hidden="true">{expanded ? 'Hide details' : 'Details'}</span>
          </button>
        )}

        {hasDetails && expanded && (
          <div id={detailsId} role="region" aria-labelledby={titleId} className={styles.details}>
            {description && <p className={styles.description}>{description}</p>}
            {total > 0 && (
              <ul className={styles.subtaskList}>
                {subtasks.map((subtask) => (
                  // Everything in here stops at the row: a subtask click or key can never toggle, select or edit the parent.
                  <li key={subtask.id} className={styles.subtaskRow} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                    <label className={styles.subtaskLabel}>
                      <input
                        type="checkbox"
                        className={styles.subtaskBox}
                        checked={subtask.completed}
                        disabled={isDisabled}
                        onChange={() => onToggleSubtask(task._id, subtask.id)}
                      />
                      <span className={subtask.completed ? styles.subtaskDone : undefined}>{subtask.title}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {task.tags.length > 0 && (
          <div className="task-tag-row">
            {task.tags.map((tag) => {
              const norm = normalizeTag(tag);
              return (
                <button
                  key={`${task._id}-tag-${norm}`}
                  type="button"
                  className={`tag-chip task-tag-chip ${tagFilter === norm ? 'active-filter' : ''}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onToggleTagFilter(norm);
                  }}
                  aria-pressed={tagFilter === norm}
                  aria-label={`Filter by tag: ${norm}`}
                >
                  {norm}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={`task-actions ${styles.actions}`}>
        <span className={`${styles.selectSlot} ${selectionMode || isSelected ? styles.selectSlotShown : ''}`}>
          <input
            type="checkbox"
            className={styles.selectBox}
            checked={isSelected}
            onChange={() => onToggleSelect(task._id)}
            disabled={isDisabled}
            aria-label={`Select task: ${task.title}`}
          />
        </span>

        <button
          type="button"
          className={`${styles.iconBtn} ${styles.editBtn}`}
          onClick={() => onStartEditing(task)}
          disabled={isDisabled}
          aria-label={`Edit task: ${task.title}`}
          title="Edit"
        >
          <PencilIcon />
        </button>

        <button
          type="button"
          className={`${styles.iconBtn} ${styles.deleteBtn}`}
          onClick={() => onDeleteTask(task._id)}
          disabled={isDisabled}
          aria-label={`Delete task: ${task.title}`}
          aria-busy={isActioning}
          title="Delete"
        >
          {isActioning ? <span aria-hidden="true">…</span> : <TrashIcon />}
        </button>
      </div>
    </div>
  );
}
