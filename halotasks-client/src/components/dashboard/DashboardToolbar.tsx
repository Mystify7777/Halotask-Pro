import type { ReactNode } from 'react';

type DashboardToolbarProps = {
  filters: ReactNode;
  syncArea: ReactNode;
  inlineActions: ReactNode;
  bulkActions: ReactNode;
  statusMessages: ReactNode;
};

export default function DashboardToolbar({
  filters,
  syncArea,
  inlineActions,
  bulkActions,
  statusMessages,
}: DashboardToolbarProps) {
  return (
    <div className="toolbar-panel panel">
      <div className="toolbar-filters">{filters}</div>

      <div className="toolbar-meta">
        {syncArea}
        {inlineActions}
      </div>

      {bulkActions && <div className="toolbar-bulk">{bulkActions}</div>}

      {statusMessages && <div className="toolbar-status">{statusMessages}</div>}
    </div>
  );
}
