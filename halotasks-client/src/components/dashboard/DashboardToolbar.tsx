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
    <>
      {filters}
      {syncArea}
      {inlineActions}
      {bulkActions}
      {statusMessages}
    </>
  );
}
