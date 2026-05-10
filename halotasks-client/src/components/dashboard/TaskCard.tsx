import { Task } from '../../types/task';
import { getDateBadgeClass } from '../../utils/dateHelpers';
import { normalizeTag } from '../../utils/tagHelpers';
import styles from './TaskCard.module.css';

type TaskCardProps = {
  task:               Task;
  activeActionTaskId: string | null;
  tagFilter:          string | null;
  isSelected:         boolean;
  bulkActionLoading:  boolean;
  onToggleTask:       (task: Task) => void;
  onDeleteTask:       (taskId: string) => void;
  onStartEditing:     (task: Task) => void;
  onToggleTagFilter:  (tag: string) => void;
  onToggleSelect:     (taskId: string) => void;
};

function formatDueLabel(dueDate?: string): string {
  if (!dueDate) return '';
  const date = new Date(dueDate);
  if (isNaN(date.getTime())) return '';

  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(today.getDate() + 1);

  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(date, today)) return 'Due today';
  if (sameDay(date, tomorrow)) return 'Due tomorrow';
  return `Due ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

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
  onDeleteTask,
  onStartEditing,
  onToggleTagFilter,
  onToggleSelect,
}: TaskCardProps) {
  const isActioning = activeActionTaskId === task._id;
  const isDisabled = isActioning || bulkActionLoading;
  const dueLabel = formatDueLabel(task.dueDate);
  const dueClass = getDateBadgeClass(task.dueDate);
  const dotClass = PRIORITY_DOT[task.priority] ?? 'low';

  return (
    <div className={`task-item ${task.completed ? 'complete' : ''} ${styles.card}`}>
      <span
        role="checkbox"
        aria-checked={task.completed}
        aria-label={`Mark "${task.title}" as ${task.completed ? 'incomplete' : 'complete'}`}
        tabIndex={isDisabled ? -1 : 0}
        className={`task-check ${task.completed ? 'checked' : ''} ${styles.check}`}
        onClick={() => !isDisabled && onToggleTask(task)}
        onKeyDown={(e) => e.key === 'Enter' && !isDisabled && onToggleTask(task)}
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
        <strong className={styles.title}>{task.title}</strong>

        <div className={styles.meta}>
          <span className={styles.priorityWrap}>
            <span className={`priority-dot ${dotClass}`} aria-hidden="true" />
            <span className={styles.priorityLabel}>{PRIORITY_LABEL[task.priority] ?? task.priority}</span>
          </span>

          {dueLabel && <span className={`${dueClass} ${styles.metaItem}`}>{dueLabel}</span>}

          {task.estimatedMinutes > 0 && (
            <span className={styles.metaItem}>
              ⏱ {task.estimatedMinutes < 60
                ? `${task.estimatedMinutes}m`
                : `${Math.floor(task.estimatedMinutes / 60)}h${task.estimatedMinutes % 60 > 0 ? ` ${task.estimatedMinutes % 60}m` : ''}`}
            </span>
          )}

          {task.pendingSync && <span className="task-pending-sync">⟳ Syncing</span>}
        </div>

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
