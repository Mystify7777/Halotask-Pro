import { useMemo } from 'react';
import { Task } from '../../types/task';
import { TaskEditState } from './types';
import TaskCard from './TaskCard';
import TaskEditForm from './TaskEditForm';

type AddTagResult = {
  message: string | null;
};

type TaskListProps = {
  tasks: Task[];
  loadingTasks: boolean;
  activeActionTaskId: string | null;
  selectedIds: string[];
  bulkActionLoading: boolean;
  editingTaskId: string | null;
  editState: TaskEditState | null;
  editTagSuggestions: string[];
  tagFilter: string | null;
  onEditStateChange: (stateUpdater: (current: TaskEditState | null) => TaskEditState | null) => void;
  onStartEditing: (task: Task) => void;
  onCancelEditing: () => void;
  onSaveTaskEdit: (taskId: string) => void;
  onToggleTask: (task: Task) => void;
  onDeleteTask: (taskId: string) => void;
  onToggleSelect: (taskId: string) => void;
  onToggleTagFilter: (tag: string) => void;
  onAddEditTag: (tag: string) => AddTagResult;
  onRemoveEditTag: (tag: string) => void;
  emptyStateTitle: string;
  emptyStateMessage: string;
};

export default function TaskList({
  tasks,
  loadingTasks,
  activeActionTaskId,
  selectedIds,
  bulkActionLoading,
  editingTaskId,
  editState,
  editTagSuggestions,
  tagFilter,
  onEditStateChange,
  onStartEditing,
  onCancelEditing,
  onSaveTaskEdit,
  onToggleTask,
  onDeleteTask,
  onToggleSelect,
  onToggleTagFilter,
  onAddEditTag,
  onRemoveEditTag,
  emptyStateTitle,
  emptyStateMessage,
}: TaskListProps) {
  // O(1) per-task lookup — avoids O(n²) Array.includes inside the render loop
  const selectedIdsSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  /** Three shimmer cards shown while tasks are loading */
  function TaskListSkeleton() {
    return (
      <ul className="task-list" aria-busy="true" aria-label="Loading tasks">
        {[0, 1, 2].map((i) => (
          <li key={i} className="task-item task-skeleton" aria-hidden="true">
            <div className="skeleton-check" />
            <div className="skeleton-body">
              <div className="skeleton-line skeleton-title" />
              <div className="skeleton-line skeleton-meta" />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  /** Empty state with contextual icon — first-run vs filtered */
  function TaskEmptyState({ title, message }: { title: string; message: string }) {
    const isFirstRun = title === 'No tasks yet';
    return (
      <div className="task-empty-state">
        <span className="task-empty-icon" aria-hidden="true">
          {isFirstRun ? '🌱' : '🔍'}
        </span>
        <strong className="task-empty-title">{title}</strong>
        <p className="task-empty-msg">{message}</p>
      </div>
    );
  }

  if (loadingTasks) {
    return <TaskListSkeleton />;
  }

  if (tasks.length === 0) {
    return <TaskEmptyState title={emptyStateTitle} message={emptyStateMessage} />;
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task._id} className={task.completed ? 'task-item complete' : 'task-item'}>
          {editingTaskId === task._id && editState ? (
            <TaskEditForm
              taskId={task._id}
              editState={editState}
              activeActionTaskId={activeActionTaskId}
              editTagSuggestions={editTagSuggestions}
              onEditStateChange={onEditStateChange}
              onSaveTaskEdit={onSaveTaskEdit}
              onCancelEditing={onCancelEditing}
              onAddEditTag={onAddEditTag}
              onRemoveEditTag={onRemoveEditTag}
            />
          ) : (
            <TaskCard
              task={task}
              activeActionTaskId={activeActionTaskId}
              tagFilter={tagFilter}
              isSelected={selectedIdsSet.has(task._id)}
              bulkActionLoading={bulkActionLoading}
              onToggleTask={onToggleTask}
              onDeleteTask={onDeleteTask}
              onStartEditing={onStartEditing}
              onToggleTagFilter={onToggleTagFilter}
              onToggleSelect={onToggleSelect}
            />
          )}
        </li>
      ))}
    </ul>
  );
}
