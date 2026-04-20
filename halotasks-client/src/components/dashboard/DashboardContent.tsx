import type { ReactNode } from 'react';

type DashboardContentProps = {
  smartSections: ReactNode;
  taskList: ReactNode;
};

export default function DashboardContent({ smartSections, taskList }: DashboardContentProps) {
  return (
    <>
      {smartSections}
      {taskList}
    </>
  );
}
