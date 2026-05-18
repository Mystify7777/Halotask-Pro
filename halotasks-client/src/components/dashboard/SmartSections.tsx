import { Task } from '../../types/task';
import {
  getCompletedToday,
  getDueTodayTasks,
  getEstimatedWorkload,
  getOverdueTasks,
  getUpcomingTasks,
  getWorkDoneToday,
} from '../../utils/taskInsights';

type SmartSectionsProps = {
  tasks: Task[];
};

type InsightCardVariant =
  | 'overdue'
  | 'due-today'
  | 'upcoming'
  | 'completed'
  | 'workload'
  | 'work-done';

type InsightCardProps = {
  label: string;
  value: string | number;
  variant: InsightCardVariant;
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

/** Format minutes as "Xh Ym" or "X min" */
const formatMinutes = (mins: number): string =>
  mins >= 60
    ? `${Math.floor(mins / 60)}h ${mins % 60}m`
    : `${mins} min`;

export default function SmartSections({ tasks }: SmartSectionsProps) {
  const overdueCount        = getOverdueTasks(tasks).length;
  const dueTodayCount       = getDueTodayTasks(tasks).length;
  const upcomingCount       = getUpcomingTasks(tasks).length;
  const completedTodayCount = getCompletedToday(tasks).length;
  const workloadMinutes     = getEstimatedWorkload(tasks);
  const workDoneMinutes     = getWorkDoneToday(tasks);

  return (
    <section className="smart-sections" aria-label="Productivity snapshot">
      <InsightCard icon="⚠️" label="Overdue"          value={overdueCount}               variant="overdue"   />
      <InsightCard icon="📅" label="Due Today"         value={dueTodayCount}              variant="due-today" />
      <InsightCard icon="🔜" label="Upcoming"          value={upcomingCount}              variant="upcoming"  />
      <InsightCard icon="✅" label="Completed Today"   value={completedTodayCount}        variant="completed" />
      <InsightCard icon="⏱️" label="Workload Today"    value={formatMinutes(workloadMinutes)} variant="workload"  />
      <InsightCard icon="💪" label="Work Done Today"   value={formatMinutes(workDoneMinutes)} variant="work-done" />
    </section>
  );
}
