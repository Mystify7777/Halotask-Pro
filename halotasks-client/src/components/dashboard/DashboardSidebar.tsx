import type { ReactNode } from 'react';

type DashboardSidebarProps = {
  taskPanel: ReactNode;
  growthPanel: ReactNode;
};

export default function DashboardSidebar({ taskPanel, growthPanel }: DashboardSidebarProps) {
  return (
    <div className="sidebar">
      <div className="panel">{taskPanel}</div>
      {growthPanel != null ? <div className="panel">{growthPanel}</div> : null}
    </div>
  );
}
