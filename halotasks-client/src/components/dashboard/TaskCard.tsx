import { useState } from 'react';
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

export default function TaskCard({
  task,
  activeActionTaskId,
  tagFilter,
  isSelected,
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
  const subtasks = getSubtasks(task);
  const { done, total } = subtaskProgress(task);
  const description = task.description?.trim() ? task.description : '';
  const hasDetails = total > 0 || description !== '';
  const titleId = `${task._id}-title`;
  const detailsId = `${task._id}-details`;

  return (
    <div className={`task-item ${task.completed ? 'complete' : ''} ${styles.card}`}>
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
        <strong id={titleId} className={styles.title}>{task.title}</strong>

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
        <input
          type="checkbox"
          className={styles.selectBox}
          checked={isSelected}
          onChange={() => onToggleSelect(task._id)}
          disabled={isDisabled}
          aria-label={`Select task: ${task.title}`}
        />

        <button
          type="button"
          className={`ghost-btn btn-sm ${styles.editBtn}`}
          onClick={() => onStartEditing(task)}
          disabled={isDisabled}
          aria-label={`Edit task: ${task.title}`}
        >
          Edit
        </button>

        <button
          type="button"
          className={`danger-btn btn-sm ${styles.deleteBtn}`}
          onClick={() => onDeleteTask(task._id)}
          disabled={isDisabled}
          aria-label={`Delete task: ${task.title}`}
        >
          {isActioning ? '...' : 'Del'}
        </button>
      </div>
    </div>
  );
}
