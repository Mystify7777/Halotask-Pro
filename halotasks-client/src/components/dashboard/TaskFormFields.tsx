import { ReactNode, RefObject } from 'react';
import { Priority, Subtask } from '../../types/task';
import { SUGGESTED_TAGS } from '../../utils/tagHelpers';
import TagInput from '../shared/TagInput';
import SubtaskEditor from './SubtaskEditor';

type AddTagResult = {
  message: string | null;
};

type TaskFormFieldsProps = {
  title: string;
  priority: Priority;
  dueDate: string;
  dueTime: string;
  startTime: string;
  estimatedMinutes: string;
  tags: string[];
  tagInput: string;
  tagSuggestions: string[];
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
  onTitleChange: (value: string) => void;
  onPriorityChange: (value: Priority) => void;
  onDueDateChange: (value: string) => void;
  onDueTimeChange: (value: string) => void;
  onStartTimeChange: (value: string) => void;
  onEstimatedMinutesChange: (value: string) => void;
  onTagInputChange: (value: string) => void;
  onAddTag: (tag: string) => AddTagResult;
  onRemoveTag: (tag: string) => void;
  /** Optional: the description and checklist controls appear only when their handlers are given. */
  description?: string;
  onDescriptionChange?: (value: string) => void;
  subtasks?: Subtask[];
  onSubtasksChange?: (next: Subtask[]) => void;
  subtasksError?: string | null;
  aiButton?: ReactNode;
  children?: ReactNode;
};

/** Mirrors the server's limit (DESCRIPTION_MAX_LENGTH): the server stays authoritative. */
export const DESCRIPTION_MAX_LENGTH = 2000;

export default function TaskFormFields({
  title,
  priority,
  dueDate,
  dueTime,
  startTime,
  estimatedMinutes,
  tags,
  tagInput,
  tagSuggestions,
  autoFocus,
  inputRef,
  onTitleChange,
  onPriorityChange,
  onDueDateChange,
  onDueTimeChange,
  onStartTimeChange,
  onEstimatedMinutesChange,
  onTagInputChange,
  onAddTag,
  onRemoveTag,
  description,
  onDescriptionChange,
  subtasks,
  onSubtasksChange,
  subtasksError,
  aiButton,
  children,
}: TaskFormFieldsProps) {
  return (
    <>
      <div className="title-input-row">
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
        {aiButton}
      </div>

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

      <div className="form-row-2col">
        <label className="form-field-label">
          <span>Due time (optional)</span>
          <input
            type="time"
            value={dueTime}
            onChange={(event) => onDueTimeChange(event.target.value)}
            disabled={!dueDate}
            aria-label="Due time"
          />
        </label>

        <label className="form-field-label">
          <span>Start (optional)</span>
          <input
            type="datetime-local"
            value={startTime}
            onChange={(event) => onStartTimeChange(event.target.value)}
            aria-label="Start time"
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

      {onDescriptionChange && (
        <label className="form-field-label">
          <span>Description (optional)</span>
          <textarea
            value={description ?? ''}
            onChange={(event) => onDescriptionChange(event.target.value)}
            maxLength={DESCRIPTION_MAX_LENGTH}
            rows={3}
            placeholder="Details, links, notes"
            aria-label="Description"
          />
        </label>
      )}

      {onSubtasksChange && <SubtaskEditor subtasks={subtasks ?? []} onChange={onSubtasksChange} error={subtasksError} />}

      {children}
    </>
  );
}