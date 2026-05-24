import { FormEvent, RefObject } from 'react';
import { Priority } from '../../types/task';
import TaskFormFields from './TaskFormFields';

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
  autoFocus?: boolean;
  inputRef?: RefObject<HTMLInputElement | null>;
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
  autoFocus,
  inputRef,
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
    <form className="task-create-form" onSubmit={onSubmit} noValidate>
      <TaskFormFields
        title={title}
        priority={priority}
        dueDate={dueDate}
        estimatedMinutes={estimatedMinutes}
        tags={tags}
        tagInput={tagInput}
        tagSuggestions={tagSuggestions}
        autoFocus={autoFocus}
        inputRef={inputRef}
        onTitleChange={onTitleChange}
        onPriorityChange={onPriorityChange}
        onDueDateChange={onDueDateChange}
        onEstimatedMinutesChange={onEstimatedMinutesChange}
        onTagInputChange={onTagInputChange}
        onAddTag={onAddTag}
        onRemoveTag={onRemoveTag}
      />
      <button
        type="submit"
        className="btn-primary"
        disabled={creatingTask || !title.trim()}
        aria-busy={creatingTask}
      >
        {creatingTask ? 'Saving…' : 'Add Task'}
      </button>
    </form>
  );
}
