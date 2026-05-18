import { useState } from 'react';
import { Task } from '../../types/task';
import {
  getCompletedToday,
  getDueTodayTasks,
  getEstimatedWorkload,
  getOverdueTasks,
  getUpcomingTasks,
  getWorkDoneToday,
} from '../../utils/taskInsights';
import InsightModal from './InsightModal';

type SmartSectionsProps = {
  tasks: Task[];
  onToggleTask: (task: Task) => void;
};

type InsightCardVariant =
  | 'overdue'
  | 'due-today'
  | 'upcoming'
  | 'completed'
  | 'workload'
  | 'work-done';

type ModalKey = InsightCardVariant | null;

type InsightCardProps = {
  label: string;
  value: string | number;
  variant: InsightCardVariant;
  icon: string;
  onClick: () => void;
};

function InsightCard({ label, value, variant, icon, onClick }: InsightCardProps) {
  return (
    <button
      type="button"
      className={`insight-card ${variant}`}
      aria-label={`${label}: ${value}. Tap to view tasks.`}
      onClick={onClick}
    >
      <span className="insight-icon" aria-hidden="true">{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </button>
  );
}

/** Format minutes as "Xh Ym" or "X min" */
const formatMinutes = (mins: number): string =>
  mins >= 60
    ? `${Math.floor(mins / 60)}h ${mins % 60}m`
    : `${mins} min`;

const PRIORITY_RANK = { high: 3, medium: 2, low: 1 } as const;

export default function SmartSections({ tasks, onToggleTask }: SmartSectionsProps) {
  const [openModal, setOpenModal] = useState<ModalKey>(null);

  // ── Derived counts for card display ──────────────────────────────────────
  const overdueTasks        = getOverdueTasks(tasks);
  const dueTodayTasks       = getDueTodayTasks(tasks);
  const completedTodayTasks = getCompletedToday(tasks);
  const workloadMinutes     = getEstimatedWorkload(tasks);
  const workDoneMinutes     = getWorkDoneToday(tasks);

  // ── Task subsets for each modal (sorted) ──────────────────────────────────
  const modalTasks: Record<InsightCardVariant, Task[]> = {
    'overdue': [...overdueTasks].sort(
      (a, b) => new Date(a.dueDate ?? 0).getTime() - new Date(b.dueDate ?? 0).getTime(),
    ),
    'due-today': [...dueTodayTasks].sort(
      (a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority],
    ),
    'upcoming': getUpcomingTasks(tasks, Number.MAX_SAFE_INTEGER).sort(
      (a, b) => new Date(a.dueDate ?? 0).getTime() - new Date(b.dueDate ?? 0).getTime(),
    ),
    'completed': [...completedTodayTasks].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    ),
    'workload': tasks
      .filter((t) => !t.completed && t.estimatedMinutes > 0)
      .sort((a, b) => b.estimatedMinutes - a.estimatedMinutes),
    'work-done': [...completedTodayTasks]
      .filter((t) => t.estimatedMinutes > 0)
      .sort((a, b) => b.estimatedMinutes - a.estimatedMinutes),
  };

  const MODAL_META: Record<InsightCardVariant, { title: string; emptyMessage: string }> = {
    'overdue':   { title: 'Overdue Tasks',         emptyMessage: 'No overdue tasks — great work! 🎉' },
    'due-today': { title: 'Due Today',             emptyMessage: 'Nothing due today.' },
    'upcoming':  { title: 'Upcoming Tasks',        emptyMessage: 'No upcoming tasks scheduled.' },
    'completed': { title: 'Completed Today',       emptyMessage: 'No tasks completed today yet.' },
    'workload':  { title: 'Workload Today',        emptyMessage: 'No tasks with time estimates.' },
    'work-done': { title: 'Work Done Today',       emptyMessage: 'No estimated work completed yet.' },
  };

  const open = (key: InsightCardVariant) => setOpenModal(key);
  const close = () => setOpenModal(null);

  return (
    <>
      <section className="smart-sections" aria-label="Productivity snapshot">
        <InsightCard icon="⚠️" label="Overdue"         value={overdueTasks.length}              variant="overdue"   onClick={() => open('overdue')}   />
        <InsightCard icon="📅" label="Due Today"        value={dueTodayTasks.length}             variant="due-today" onClick={() => open('due-today')} />
        <InsightCard icon="🔜" label="Upcoming"         value={getUpcomingTasks(tasks).length}   variant="upcoming"  onClick={() => open('upcoming')}  />
        <InsightCard icon="✅" label="Completed Today"  value={completedTodayTasks.length}       variant="completed" onClick={() => open('completed')} />
        <InsightCard icon="⏱️" label="Workload Today"   value={formatMinutes(workloadMinutes)}   variant="workload"  onClick={() => open('workload')}  />
        <InsightCard icon="💪" label="Work Done Today"  value={formatMinutes(workDoneMinutes)}   variant="work-done" onClick={() => open('work-done')} />
      </section>

      {openModal && (
        <InsightModal
          isOpen
          title={MODAL_META[openModal].title}
          tasks={modalTasks[openModal]}
          emptyMessage={MODAL_META[openModal].emptyMessage}
          onClose={close}
          onToggleTask={(task) => {
            onToggleTask(task);
            // keep modal open so the user can toggle multiple tasks
          }}
        />
      )}
    </>
  );
}
