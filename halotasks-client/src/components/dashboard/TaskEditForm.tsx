import { Priority } from '../../types/task';
import TaskFormFields from './TaskFormFields';
import { TaskEditState } from './types';

type AddTagResult = {
  message: string | null;
};

type TaskEditFormProps = {
  taskId: string;
  editState: TaskEditState;
  activeActionTaskId: string | null;
  editTagSuggestions: string[];
  onEditStateChange: (stateUpdater: (current: TaskEditState | null) => TaskEditState | null) => void;
  onSaveTaskEdit: (taskId: string) => void;
  onCancelEditing: () => void;
  onAddEditTag: (tag: string) => AddTagResult;
  onRemoveEditTag: (tag: string) => void;
};

export default function TaskEditForm({
  taskId,
  editState,
  activeActionTaskId,
  editTagSuggestions,
  onEditStateChange,
  onSaveTaskEdit,
  onCancelEditing,
  onAddEditTag,
  onRemoveEditTag,
}: TaskEditFormProps) {
  return (
    <div className="edit-panel">
      <TaskFormFields
        title={editState.title}
        priority={editState.priority}
        dueDate={editState.dueDate}
        estimatedMinutes={editState.estimatedMinutes}
        tags={editState.tags}
        tagInput={editState.tagInput}
        tagSuggestions={editTagSuggestions}
        onTitleChange={(value) =>
          onEditStateChange((current) =>
            current
              ? {
                  ...current,
                  title: value,
                }
              : current,
          )
        }
        onPriorityChange={(value) =>
          onEditStateChange((current) =>
            current
              ? {
                  ...current,
                  priority: value,
                }
              : current,
          )
        }
        onDueDateChange={(value) =>
          onEditStateChange((current) =>
            current
              ? {
                  ...current,
                  dueDate: value,
                }
              : current,
          )
        }
        onEstimatedMinutesChange={(value) =>
          onEditStateChange((current) =>
            current
              ? {
                  ...current,
                  estimatedMinutes: value,
                }
              : current,
          )
        }
        onTagInputChange={(value) =>
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
      />
      <div className="task-actions">
        <button type="button" onClick={() => onSaveTaskEdit(taskId)} disabled={activeActionTaskId === taskId}>
          {activeActionTaskId === taskId ? 'Saving...' : 'Save'}
        </button>
        <button className="ghost-btn" onClick={onCancelEditing} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
