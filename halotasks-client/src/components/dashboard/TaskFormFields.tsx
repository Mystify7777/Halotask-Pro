import { ReactNode, RefObject } from 'react';
import { Priority } from '../../types/task';
import { SUGGESTED_TAGS } from '../../utils/tagHelpers';
import TagInput from '../shared/TagInput';

type AddTagResult = {
  message: string | null;
};

type TaskFormFieldsProps = {
  title: string;
  priority: Priority;
  dueDate: string;
  estimatedMinutes: string;
  tags: string[];
  tagInput: string;
  tagSuggestions: string[];
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onTitleChange: (value: string) => void;
  onPriorityChange: (value: Priority) => void;
  onDueDateChange: (value: string) => void;
  onEstimatedMinutesChange: (value: string) => void;
  onTagInputChange: (value: string) => void;
  onAddTag: (tag: string) => AddTagResult;
  onRemoveTag: (tag: string) => void;
  children?: ReactNode;
};

export default function TaskFormFields({
  title,
  priority,
  dueDate,
  estimatedMinutes,
  tags,
  tagInput,
  tagSuggestions,
  autoFocus,
  inputRef,
  onTitleChange,
  onPriorityChange,
  onDueDateChange,
  onEstimatedMinutesChange,
  onTagInputChange,
  onAddTag,
  onRemoveTag,
  children,
}: TaskFormFieldsProps) {
  return (
    <>
      <input
        type="text"
        placeholder="Add a task title"
        value={title}
        onChange={(event) => onTitleChange(event.target.value)}
        ref={inputRef}
        autoFocus={autoFocus}
        aria-label="Task title"
        required
      />

      <div className="form-row-2col">
        <label className="form-field-label">
          <span>Priority</span>
          <select
            value={priority}
            onChange={(event) => onPriorityChange(event.target.value as Priority)}
            aria-label="Priority"
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </label>

        <label className="form-field-label">
          <span>Due date</span>
          <input
            type="date"
            value={dueDate}
            onChange={(event) => onDueDateChange(event.target.value)}
            aria-label="Due date"
          />
        </label>
      </div>

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

      <label className="form-field-label">
        <span>Estimated time</span>
        <input
          type="number"
          min={0}
          value={estimatedMinutes}
          onChange={(event) => onEstimatedMinutesChange(event.target.value)}
          placeholder="Minutes"
          aria-label="Estimated minutes"
        />
      </label>

      {children}
    </>
  );
}