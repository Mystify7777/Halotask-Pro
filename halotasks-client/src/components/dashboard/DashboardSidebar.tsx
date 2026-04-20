import type { ReactNode } from 'react';

type DashboardSidebarProps = {
  taskPanel: ReactNode;
  growthPanel: ReactNode;
};

export default function DashboardSidebar({ taskPanel, growthPanel }: DashboardSidebarProps) {
  return (
    <>
      <div className="panel">{taskPanel}</div>
      <div className="panel">{growthPanel}</div>
    </>
  );
}
