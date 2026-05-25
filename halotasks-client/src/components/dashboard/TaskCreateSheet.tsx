import { useEffect, useRef } from 'react';
import TaskCreateForm, { type TaskCreateFormProps } from './TaskCreateForm';

type TaskCreateSheetProps = {
  isOpen: boolean;
  onClose: () => void;
} & Omit<TaskCreateFormProps, 'autoFocus'>;

export default function TaskCreateSheet({
  isOpen,
  onClose,
  ...formProps
}: TaskCreateSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      sheetRef.current?.focus();
    }
  }, [isOpen]);

  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    if (!isMobile) return;
    document.body.style.overflow = isOpen ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <>
      <div
        className="sheet-backdrop"
        aria-hidden="true"
        onClick={onClose}
      />

      <div
        ref={sheetRef}
        className="task-create-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Create new task"
        tabIndex={-1}
      >
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
          <TaskCreateForm {...formProps} autoFocus inputRef={formProps.inputRef} />
        </div>
      </div>
    </>
  );
}
