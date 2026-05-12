import { Task } from '../../types/task';
import {
  getCompletedToday,
  getDueTodayTasks,
  getEstimatedWorkload,
  getOverdueTasks,
  getUpcomingTasks,
} from '../../utils/taskInsights';

type SmartSectionsProps = {
  tasks: Task[];
};

type InsightCardProps = {
  label: string;
  value: string | number;
  variant: 'overdue' | 'due-today' | 'upcoming' | 'completed' | 'workload';
  icon: string;
};

function InsightCard({ label, value, variant, icon }: InsightCardProps) {
  return (
    <article className={`insight-card ${variant}`} aria-label={`${label}: ${value}`}>
      <span className="insight-icon" aria-hidden="true">
        {icon}
      </span>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

export default function SmartSections({ tasks }: SmartSectionsProps) {
  const overdueCount = getOverdueTasks(tasks).length;
  const dueTodayCount = getDueTodayTasks(tasks).length;
  const upcomingCount = getUpcomingTasks(tasks).length;
  const completedTodayCount = getCompletedToday(tasks).length;
  const workloadMinutes = getEstimatedWorkload(tasks);

  const workloadLabel =
    workloadMinutes >= 60
      ? `${Math.floor(workloadMinutes / 60)}h ${workloadMinutes % 60}m`
      : `${workloadMinutes} min`;

  return (
    <section className="smart-sections" aria-label="Productivity snapshot">
      <InsightCard icon="⚠️" label="Overdue" value={overdueCount} variant="overdue" />
      <InsightCard icon="📅" label="Due Today" value={dueTodayCount} variant="due-today" />
      <InsightCard icon="🔜" label="Upcoming" value={upcomingCount} variant="upcoming" />
      <InsightCard icon="✅" label="Completed Today" value={completedTodayCount} variant="completed" />
      <InsightCard icon="⏱️" label="Workload Today" value={workloadLabel} variant="workload" />
    </section>
  );
}
