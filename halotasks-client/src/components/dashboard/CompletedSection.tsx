import { useState } from 'react';
import { Task } from '../../types/task';

type CompletedSectionProps = {
  tasks: Task[];
  onToggleTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
};

export default function CompletedSection({
  tasks,
  onToggleTask,
  onDeleteTask,
}: CompletedSectionProps) {
  const [isExpanded, setIsExpanded] = useState(false);

  if (tasks.length === 0) return null;

  return (
    <div className="completed-section">
      <button
        type="button"
        className="completed-section-toggle"
        onClick={() => setIsExpanded((v) => !v)}
        aria-expanded={isExpanded}
        aria-controls="completed-section-list"
      >
        <span className="completed-section-chevron" aria-hidden="true">
          {isExpanded ? '▾' : '▸'}
        </span>
        <span>Completed</span>
        <span className="completed-section-count">{tasks.length}</span>
      </button>

      {isExpanded && (
        <ul
          id="completed-section-list"
          className="task-list completed-section-list"
          aria-label={`${tasks.length} completed tasks`}
        >
          {tasks.map((task) => (
            <li key={task._id} className="task-item complete completed-section-task">
              {/* Re-activate toggle */}
              <button
                type="button"
                className="completed-section-circle checked"
                onClick={() => onToggleTask(task)}
                aria-label={`Mark "${task.title}" incomplete`}
              >
                <span aria-hidden="true">✓</span>
              </button>

              {/* Title */}
              <span className="completed-section-title">{task.title}</span>

              {/* Priority dot */}
              <span
                className={`completed-section-dot priority-${task.priority}`}
                aria-label={`${task.priority} priority`}
              />

              {/* Delete */}
              <button
                type="button"
                className="ghost-btn btn-sm completed-section-delete"
                onClick={() => onDeleteTask(task._id)}
                aria-label={`Delete "${task.title}"`}
              >
                Del
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
