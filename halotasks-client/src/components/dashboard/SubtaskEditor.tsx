import { KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { Subtask } from '../../types/task';
import { MAX_SUBTASKS, SUBTASK_TITLE_MAX_LENGTH, newSubtaskId } from '../../utils/subtasks';

type SubtaskEditorProps = {
  subtasks: Subtask[];
  onChange: (next: Subtask[]) => void;
  /** Why the last save was refused. Shown next to the list; the list itself is never altered by it. */
  error?: string | null;
};

/**
 * Creates, renames and removes the checklist of a task (Issue #15), inside the shared create/edit form. Completion is
 * NOT changed here (that is the card's checkbox), so an existing entry keeps its id and its state exactly; only a NEW
 * entry gets an id (`newSubtaskId`), once, when it is added. Blank rows are allowed while typing and are dropped when
 * the form is saved (utils/subtasks.ts prepareSubtasks).
 *
 * Enter never submits the surrounding form from here: it moves on to the next row, or adds a row after the last one.
 */
export default function SubtaskEditor({ subtasks, onChange, error }: SubtaskEditorProps) {
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const addButton = useRef<HTMLButtonElement>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const atLimit = subtasks.length >= MAX_SUBTASKS;

  useEffect(() => {
    if (focusId === null) return;
    inputs.current.get(focusId)?.focus();
    setFocusId(null);
  }, [focusId, subtasks]);

  const add = () => {
    if (atLimit) return;
    const id = newSubtaskId();
    onChange([...subtasks, { id, title: '', completed: false }]);
    setFocusId(id);
  };

  const rename = (id: string, title: string) =>
    onChange(subtasks.map((subtask) => (subtask.id === id ? { ...subtask, title } : subtask)));

  const remove = (index: number) => {
    const next = subtasks.filter((_, i) => i !== index);
    onChange(next);
    const neighbour = next[index] ?? next[index - 1];
    if (neighbour) setFocusId(neighbour.id);
    else addButton.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>, index: number) => {
    if (event.key !== 'Enter') return;
    event.preventDefault(); // never submit the create form from here
    const next = subtasks[index + 1];
    if (next) setFocusId(next.id);
    else if (subtasks[index].title.trim()) add();
  };

  return (
    <fieldset className="subtask-editor">
      <legend>
        Subtasks <span className="subtask-editor-count">{subtasks.length}/{MAX_SUBTASKS}</span>
      </legend>

      {subtasks.length > 0 && (
        <ul className="subtask-editor-list">
          {subtasks.map((subtask, index) => (
            <li key={subtask.id} className="subtask-editor-row">
              <input
                type="text"
                ref={(node) => {
                  if (node) inputs.current.set(subtask.id, node);
                  else inputs.current.delete(subtask.id);
                }}
                value={subtask.title}
                maxLength={SUBTASK_TITLE_MAX_LENGTH}
                onChange={(event) => rename(subtask.id, event.target.value)}
                onKeyDown={(event) => onKeyDown(event, index)}
                aria-label={`Subtask ${index + 1} title`}
                placeholder="Subtask"
              />
              <button
                type="button"
                className="ghost-btn btn-sm"
                onClick={() => remove(index)}
                aria-label={`Remove subtask ${index + 1}${subtask.title.trim() ? `: ${subtask.title.trim()}` : ''}`}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      <button type="button" ref={addButton} className="ghost-btn btn-sm" onClick={add} disabled={atLimit}>
        {atLimit ? `Limit of ${MAX_SUBTASKS} reached` : '+ Add subtask'}
      </button>

      {error && (
        <p className="subtask-editor-error" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
