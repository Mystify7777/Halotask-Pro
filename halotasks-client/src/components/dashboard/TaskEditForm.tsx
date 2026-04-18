import { Priority } from '../../types/task';
import { SUGGESTED_TAGS } from '../../utils/tagHelpers';
import TagInput from '../shared/TagInput';
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
        <button onClick={() => onSaveTaskEdit(taskId)} disabled={activeActionTaskId === taskId}>
          {activeActionTaskId === taskId ? 'Saving...' : 'Save'}
        </button>
        <button className="ghost-btn" onClick={onCancelEditing} type="button">
          Cancel
        </button>
      </div>
    </div>
  );
}
