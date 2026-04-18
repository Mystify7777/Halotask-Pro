import { Task } from '../../types/task';
import { formatDateForInput, getDateBadgeClass } from '../../utils/dateHelpers';
import { normalizeTag } from '../../utils/tagHelpers';

type TaskCardProps = {
  task: Task;
  activeActionTaskId: string | null;
  tagFilter: string | null;
  isSelected: boolean;
  bulkActionLoading: boolean;
  onToggleTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onStartEditing: (task: Task) => void;
  onToggleTagFilter: (tag: string) => void;
  onToggleSelect: (taskId: string) => void;
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
  return (
    <>
      <label>
        <input
          type="checkbox"
          checked={task.completed}
          onChange={() => onToggleTask(task)}
          disabled={activeActionTaskId === task._id || bulkActionLoading}
        />
        <span>
          <strong>{task.title}</strong>
          <small>Priority: {task.priority}</small>
          <small className={getDateBadgeClass(task.dueDate)}>
            {task.dueDate ? `Due: ${formatDateForInput(task.dueDate)}` : 'No due date'}
          </small>
          {task.tags.length > 0 && (
            <span className="task-tag-row">
              {task.tags.map((tag) => {
                const normalizedTag = normalizeTag(tag);

                return (
                  <button
                    key={`${task._id}-tag-${normalizedTag}`}
                    type="button"
                    className={tagFilter === normalizedTag ? 'tag-chip active-filter' : 'tag-chip task-tag-chip'}
                    onClick={() => onToggleTagFilter(normalizedTag)}
                  >
                    {normalizedTag}
                  </button>
                );
              })}
            </span>
          )}
          {task.estimatedMinutes > 0 && <small>Est: {task.estimatedMinutes} min</small>}
        </span>
      </label>
      <div className="task-actions">
        <label className="select-task-control">
          <input
            type="checkbox"
            checked={isSelected}
            onChange={() => onToggleSelect(task._id)}
            disabled={bulkActionLoading}
          />
          Select
        </label>
        <button className="ghost-btn" onClick={() => onStartEditing(task)} type="button" disabled={bulkActionLoading}>
          Edit
        </button>
        <button
          className="danger-btn"
          onClick={() => onDeleteTask(task._id)}
          disabled={activeActionTaskId === task._id || bulkActionLoading}
          type="button"
        >
          {activeActionTaskId === task._id ? 'Deleting...' : 'Delete'}
        </button>
      </div>
    </>
  );
}
