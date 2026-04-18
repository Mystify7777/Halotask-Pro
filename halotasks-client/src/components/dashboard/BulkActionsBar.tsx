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
    <div className="bulk-actions-bar">
      <span className="bulk-count">{selectedCount} selected</span>
      <button className="ghost-btn" type="button" onClick={onSelectAllVisible} disabled={loading || allVisibleSelected}>
        Select All Visible
      </button>
      <button className="ghost-btn" type="button" onClick={onMarkSelectedComplete} disabled={loading}>
        Mark Complete
      </button>
      <button className="danger-btn" type="button" onClick={onDeleteSelected} disabled={loading}>
        Delete Selected
      </button>
      <button className="ghost-btn" type="button" onClick={onClearSelection} disabled={loading}>
        Clear Selection
      </button>
    </div>
  );
}
