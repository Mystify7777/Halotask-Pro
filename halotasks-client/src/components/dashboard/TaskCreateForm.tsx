import { FormEvent, RefObject } from 'react';
import { Priority } from '../../types/task';
import TaskFormFields from './TaskFormFields';
import AiTaskInput from './AiTaskInput';
import type { AiPhase, AiTaskDraft } from '../../hooks/useAiTaskCreation';

type AddTagResult = {
  message: string | null;
};

export type TaskCreateFormProps = {
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
  aiPhase?: AiPhase;
  aiPrompt?: string;
  aiDrafts?: AiTaskDraft[];
  aiError?: string | null;
  aiCreatedCount?: number;
  aiTotalDrafts?: number;
  onAiOpen?: () => void;
  onAiClose?: () => void;
  onAiPromptChange?: (value: string) => void;
  onAiParse?: () => void;
  onAiRemoveDraft?: (id: string) => void;
  onAiConfirm?: () => void;
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
  aiPhase,
  aiPrompt,
  aiDrafts,
  aiError,
  aiCreatedCount,
  aiTotalDrafts,
  onAiOpen,
  onAiClose,
  onAiPromptChange,
  onAiParse,
  onAiRemoveDraft,
  onAiConfirm,
}: TaskCreateFormProps) {
  const hasAi = Boolean(onAiOpen);
  const aiActive = hasAi && aiPhase !== 'idle' && aiPhase !== undefined;

  const aiButton = hasAi ? (
    <button
      type="button"
      className="ai-sparkle-btn"
      onClick={onAiOpen}
      aria-label="Create tasks with AI"
      title="Create tasks with AI"
    >
      ✨
    </button>
  ) : undefined;

  return (
    <form className="task-create-form" onSubmit={onSubmit} noValidate>
      {aiActive ? (
        <AiTaskInput
          phase={aiPhase!}
          prompt={aiPrompt ?? ''}
          drafts={aiDrafts ?? []}
          aiError={aiError ?? null}
          createdCount={aiCreatedCount ?? 0}
          totalDrafts={aiTotalDrafts ?? 0}
          onPromptChange={onAiPromptChange!}
          onParse={onAiParse!}
          onRemoveDraft={onAiRemoveDraft!}
          onConfirm={onAiConfirm!}
          onClose={onAiClose!}
        />
      ) : (
        <>
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
            aiButton={aiButton}
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
        </>
      )}
    </form>
  );
}
