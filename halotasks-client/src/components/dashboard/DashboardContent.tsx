import type { ReactNode } from 'react';

type DashboardContentProps = {
  taskList: ReactNode;
};

// The productivity snapshot (SmartSections) lives in the toolbar panel, collapsed by default,
// so this area only shows tasks.
export default function DashboardContent({ taskList }: DashboardContentProps) {
  return <>{taskList}</>;
}
