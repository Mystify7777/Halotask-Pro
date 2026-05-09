import { FormEvent } from 'react';
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
      <TaskFormFields
        title={title}
        priority={priority}
        dueDate={dueDate}
        estimatedMinutes={estimatedMinutes}
        tags={tags}
        tagInput={tagInput}
        tagSuggestions={tagSuggestions}
        onTitleChange={onTitleChange}
        onPriorityChange={onPriorityChange}
        onDueDateChange={onDueDateChange}
        onEstimatedMinutesChange={onEstimatedMinutesChange}
        onTagInputChange={onTagInputChange}
        onAddTag={onAddTag}
        onRemoveTag={onRemoveTag}
      />
      <button type="submit" disabled={creatingTask}>
        {creatingTask ? 'Saving...' : 'Add Task'}
      </button>
    </form>
  );
}
