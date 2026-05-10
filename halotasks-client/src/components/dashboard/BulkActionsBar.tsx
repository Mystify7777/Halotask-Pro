type BulkActionsBarProps = {
  selectedCount: number;
  allVisibleSelected: boolean;
  loading: boolean;
  onSelectAllVisible: () => void;
  onClearSelection: () => void;
  onMarkSelectedComplete: () => void;
  onDeleteSelected: () => void;
};

export default function BulkActionsBar({
  selectedCount,
  allVisibleSelected,
  loading,
  onSelectAllVisible,
  onClearSelection,
  onMarkSelectedComplete,
  onDeleteSelected,
}: BulkActionsBarProps) {
  return (
    <div className="bulk-actions-bar" role="toolbar" aria-label="Bulk task actions">
      <span className="bulk-count" aria-live="polite">
        {selectedCount} selected
      </span>

      <div className="bulk-actions-btns">
        <button
          type="button"
          className="ghost-btn btn-sm"
          onClick={onSelectAllVisible}
          disabled={loading || allVisibleSelected}
        >
          Select all
        </button>
        <button
          type="button"
          className="ghost-btn btn-sm"
          onClick={onMarkSelectedComplete}
          disabled={loading}
        >
          ✓ Complete
        </button>
        <button
          type="button"
          className="danger-btn btn-sm"
          onClick={onDeleteSelected}
          disabled={loading}
          aria-label={`Delete ${selectedCount} selected tasks`}
        >
          Delete
        </button>
        <button
          type="button"
          className="ghost-btn btn-sm"
          onClick={onClearSelection}
          disabled={loading}
          aria-label="Clear selection"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
