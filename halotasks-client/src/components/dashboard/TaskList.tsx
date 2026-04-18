import { Priority, Task } from '../../types/task';
import { SUGGESTED_TAGS, normalizeTag } from '../../utils/tagHelpers';
import { formatDateForInput, getDateBadgeClass } from '../../utils/dateHelpers';
import TagInput from '../shared/TagInput';
import { TaskEditState } from './types';

type AddTagResult = {
  message: string | null;
};

type TaskListProps = {
  tasks: Task[];
  loadingTasks: boolean;
  activeActionTaskId: string | null;
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
  onToggleTagFilter: (tag: string) => void;
  onAddEditTag: (tag: string) => AddTagResult;
  onRemoveEditTag: (tag: string) => void;
};

export default function TaskList({
  tasks,
  loadingTasks,
  activeActionTaskId,
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
  onToggleTagFilter,
  onAddEditTag,
  onRemoveEditTag,
}: TaskListProps) {
  if (loadingTasks) {
    return <p>Loading tasks...</p>;
  }

  if (tasks.length === 0) {
    return <p>No tasks match the current filters.</p>;
  }

  return (
    <ul className="task-list">
      {tasks.map((task) => (
        <li key={task._id} className={task.completed ? 'task-item complete' : 'task-item'}>
          {editingTaskId === task._id && editState ? (
            <div className="edit-panel">
              <input
                type="text"
                value={editState.title}
                onChange={(event) =>
                  onEditStateChange((current) =>
                    current
                      ? {
                          ...current,
                          title: event.target.value,
                        }
                      : current,
                  )
                }
              />
              <select
                value={editState.priority}
                onChange={(event) =>
                  onEditStateChange((current) =>
                    current
                      ? {
                          ...current,
                          priority: event.target.value as Priority,
                        }
                      : current,
                  )
                }
              >
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
              <input
                type="date"
                value={editState.dueDate}
                onChange={(event) =>
                  onEditStateChange((current) =>
                    current
                      ? {
                          ...current,
                          dueDate: event.target.value,
                        }
                      : current,
                  )
                }
              />
              <TagInput
                selectedTags={editState.tags}
                inputValue={editState.tagInput}
                onInputValueChange={(value) =>
                  onEditStateChange((current) =>
                    current
                      ? {
                          ...current,
                          tagInput: value,
                        }
                      : current,
                  )
                }
                onAddTag={onAddEditTag}
                onRemoveTag={onRemoveEditTag}
                suggestedTags={SUGGESTED_TAGS}
                dynamicSuggestions={editTagSuggestions}
                placeholder="Type tag then Enter or comma"
              />
              <input
                type="number"
                min={0}
                value={editState.estimatedMinutes}
                onChange={(event) =>
                  onEditStateChange((current) =>
                    current
                      ? {
                          ...current,
                          estimatedMinutes: event.target.value,
                        }
                      : current,
                  )
                }
                placeholder="Estimated minutes"
              />
              <div className="task-actions">
                <button onClick={() => onSaveTaskEdit(task._id)} disabled={activeActionTaskId === task._id}>
                  {activeActionTaskId === task._id ? 'Saving...' : 'Save'}
                </button>
                <button className="ghost-btn" onClick={onCancelEditing} type="button">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <label>
                <input
                  type="checkbox"
                  checked={task.completed}
                  onChange={() => onToggleTask(task)}
                  disabled={activeActionTaskId === task._id}
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
                <button className="ghost-btn" onClick={() => onStartEditing(task)} type="button">
                  Edit
                </button>
                <button
                  className="danger-btn"
                  onClick={() => onDeleteTask(task._id)}
                  disabled={activeActionTaskId === task._id}
                  type="button"
                >
                  {activeActionTaskId === task._id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
