import { useEffect, useRef, type FormEvent } from 'react';
import { Priority } from '../../types/task';
import TaskCreateForm from './TaskCreateForm';

type AddTagResult = { message: string | null };

type TaskCreateSheetProps = {
  isOpen: boolean;
  onClose: () => void;
  // TaskCreateForm props — passed straight through
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

export default function TaskCreateSheet({
  isOpen,
  onClose,
  ...formProps
}: TaskCreateSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // Focus the sheet panel when it opens so keyboard users land inside it
  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  // Lock body scroll while open — only on mobile where the sheet is visible.
  // On desktop the sheet is display:none via CSS, so locking would freeze
  // the page scroll with no visible sheet to close.
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    if (!isMobile) return;
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => { document.body.style.overflow = ''; };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className="sheet-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Sheet panel */}
      <div
        ref={sheetRef}
        className="task-create-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Create new task"
        tabIndex={-1}
      >
        {/* Drag handle */}
        <div className="sheet-handle" aria-hidden="true" />

        <div className="sheet-header">
          <h2 className="sheet-title">New Task</h2>
          <button
            type="button"
            className="ghost-btn sheet-close-btn"
            onClick={onClose}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        <div className="sheet-body">
          <TaskCreateForm {...formProps} autoFocus inputRef={undefined} />
        </div>
      </div>
    </>
  );
}
