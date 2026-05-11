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

/** Convenience updater: merges partial edit state */
function patch(
  onEditStateChange: TaskEditFormProps['onEditStateChange'],
  update: Partial<TaskEditState>,
) {
  onEditStateChange((current) => (current ? { ...current, ...update } : current));
}

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
  const isSaving = activeActionTaskId === taskId;

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
        onTitleChange={(value) => patch(onEditStateChange, { title: value })}
        onPriorityChange={(value) => patch(onEditStateChange, { priority: value as Priority })}
        onDueDateChange={(value) => patch(onEditStateChange, { dueDate: value })}
        onEstimatedMinutesChange={(value) => patch(onEditStateChange, { estimatedMinutes: value })}
        onTagInputChange={(value) => patch(onEditStateChange, { tagInput: value })}
        onAddTag={onAddEditTag}
        onRemoveTag={onRemoveEditTag}
      />
      <div className="task-edit-actions">
        <button
          type="button"
          className="btn-primary btn-sm"
          onClick={() => onSaveTaskEdit(taskId)}
          disabled={isSaving || !editState.title.trim()}
          aria-busy={isSaving}
        >
          {isSaving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          className="ghost-btn btn-sm"
          onClick={onCancelEditing}
          disabled={isSaving}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
