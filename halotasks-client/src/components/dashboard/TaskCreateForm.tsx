import { FormEvent } from 'react';
import { Priority } from '../../types/task';
import { SUGGESTED_TAGS } from '../../utils/tagHelpers';
import TagInput from '../shared/TagInput';

type AddTagResult = {
  message: string | null;
};

type TaskCreateFormProps = {
  title: string;
  priority: Priority;
  dueDate: string;
  estimatedMinutes: string;
  creatingTask: boolean;
  tags: string[];
  tagInput: string;
  tagSuggestions: string[];
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTitleChange: (value: string) => void;
  onPriorityChange: (value: Priority) => void;
  onDueDateChange: (value: string) => void;
  onEstimatedMinutesChange: (value: string) => void;
  onTagInputChange: (value: string) => void;
  onAddTag: (tag: string) => AddTagResult;
  onRemoveTag: (tag: string) => void;
};

export default function TaskCreateForm({
  title,
  priority,
  dueDate,
  estimatedMinutes,
  creatingTask,
  tags,
  tagInput,
  tagSuggestions,
  onSubmit,
  onTitleChange,
  onPriorityChange,
  onDueDateChange,
  onEstimatedMinutesChange,
  onTagInputChange,
  onAddTag,
  onRemoveTag,
}: TaskCreateFormProps) {
  return (
    <form className="task-create-form" onSubmit={onSubmit}>
      <input
        type="text"
        placeholder="Add a task title"
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        required
      />
      <select value={priority} onChange={(event) => onPriorityChange(event.target.value as Priority)}>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <input
        type="date"
        value={dueDate}
        onChange={(event) => onDueDateChange(event.target.value)}
        aria-label="Due date"
      />
      <TagInput
        selectedTags={tags}
        inputValue={tagInput}
        onInputValueChange={onTagInputChange}
        onAddTag={onAddTag}
        onRemoveTag={onRemoveTag}
        suggestedTags={SUGGESTED_TAGS}
        dynamicSuggestions={tagSuggestions}
        placeholder="Type tag then Enter or comma"
      />
      <input
        type="number"
        min={0}
        value={estimatedMinutes}
        onChange={(event) => onEstimatedMinutesChange(event.target.value)}
        placeholder="Estimated minutes"
      />
      <button type="submit" disabled={creatingTask}>
        {creatingTask ? 'Saving...' : 'Add Task'}
      </button>
    </form>
  );
}
