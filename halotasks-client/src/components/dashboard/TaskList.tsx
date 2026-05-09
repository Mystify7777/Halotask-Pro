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
}: TaskListProps) {
  const selectedIdsSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  if (loadingTasks) {
    return <p>Loading tasks...</p>;
  }

  if (tasks.length === 0) {
    return <p>{tagFilter ? 'No tasks match the current filters.' : 'Create your first task to get started.'}</p>;
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
