import type { AiPhase, AiTaskDraft } from '../../hooks/useAiTaskCreation';

type AiTaskInputProps = {
  phase: AiPhase;
  prompt: string;
  drafts: AiTaskDraft[];
  aiError: string | null;
  createdCount: number;
  totalDrafts: number;
  onPromptChange: (value: string) => void;
  onParse: () => void;
  onRemoveDraft: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
};

const PRIORITY_CLASS: Record<string, string> = {
  low: 'ai-priority--low',
  medium: 'ai-priority--medium',
  high: 'ai-priority--high',
};

const PRIORITY_LABEL: Record<string, string> = {
  low: 'Low',
  medium: 'Med',
  high: 'High',
};

function formatDate(value: string) {
  try {
    return new Date(`${value}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
    });
  } catch {
    return value;
  }
}

export default function AiTaskInput({
  phase,
  prompt,
  drafts,
  aiError,
  createdCount,
  totalDrafts,
  onPromptChange,
  onParse,
  onRemoveDraft,
  onConfirm,
  onClose,
}: AiTaskInputProps) {
  const isParsing = phase === 'parsing';
  const isCreating = phase === 'creating';

  return (
    <div className="ai-panel" role="region" aria-label="AI task creation">
      <div className="ai-panel-header">
        <span className="ai-panel-title">
          <span className="ai-sparkle" aria-hidden="true">✨</span>
          AI Task Creation
        </span>
        <button
          type="button"
          className="ghost-btn ai-close-btn"
          onClick={onClose}
          aria-label="Close AI panel"
          disabled={isParsing || isCreating}
        >
          ✕
        </button>
      </div>

      {(phase === 'input' || phase === 'parsing') && (
        <div className="ai-input-area">
          <textarea
            className="ai-textarea"
            placeholder={
              'Describe your tasks in plain English…\n\n' +
              'e.g. "Review Q2 report by Friday, urgent. Also book dentist for next week and prep for Monday\'s team meeting."'
            }
            value={prompt}
            onChange={(event) => onPromptChange(event.target.value)}
            disabled={isParsing}
            rows={4}
            autoFocus
            aria-label="Describe your tasks"
          />

          {aiError && <p className="ai-error" role="alert">{aiError}</p>}

          <div className="ai-actions">
            <button type="button" className="ghost-btn" onClick={onClose} disabled={isParsing}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary ai-parse-btn"
              onClick={onParse}
              disabled={isParsing || !prompt.trim()}
              aria-busy={isParsing}
            >
              {isParsing ? <><span className="ai-spinner" aria-hidden="true" /> Parsing…</> : 'Parse →'}
            </button>
          </div>
        </div>
      )}

      {phase === 'preview' && (
        <div className="ai-preview-area">
          {drafts.length > 0 ? (
            <>
              <p className="ai-hint">
                {drafts.length} task{drafts.length !== 1 ? 's' : ''} found — remove any you don't want, then confirm.
              </p>
              <ul className="ai-draft-list" aria-label="Parsed tasks">
                {drafts.map((draft) => (
                  <li key={draft.id} className="ai-draft-item">
                    <div className="ai-draft-body">
                      <span className="ai-draft-title">{draft.title}</span>
                      <div className="ai-draft-meta">
                        <span className={`ai-priority ${PRIORITY_CLASS[draft.priority]}`}>{PRIORITY_LABEL[draft.priority]}</span>
                        {draft.dueDate && <span className="ai-meta-chip">📅 {formatDate(draft.dueDate)}</span>}
                        {draft.estimatedMinutes != null && <span className="ai-meta-chip">⏱ {draft.estimatedMinutes}m</span>}
                        {draft.tags.map((tag) => (
                          <span key={tag} className="ai-tag">{tag}</span>
                        ))}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="ghost-btn ai-remove-btn"
                      onClick={() => onRemoveDraft(draft.id)}
                      aria-label={`Remove \"${draft.title}\"`}
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="ai-hint ai-hint--empty">
              All tasks removed. <button type="button" className="ai-text-btn" onClick={onClose}>Start over</button>
            </p>
          )}

          <div className="ai-actions">
            <button type="button" className="ghost-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn-primary" onClick={onConfirm} disabled={drafts.length === 0}>
              ✨ Add {drafts.length} Task{drafts.length !== 1 ? 's' : ''}
            </button>
          </div>
        </div>
      )}

      {phase === 'creating' && (
        <div className="ai-creating-area" role="status" aria-live="polite">
          <span className="ai-spinner ai-spinner--lg" aria-hidden="true" />
          <p className="ai-creating-msg">
            Adding tasks…&nbsp;<strong>{createdCount}</strong>&nbsp;/&nbsp;<strong>{totalDrafts}</strong>
          </p>
        </div>
      )}
    </div>
  );
}
