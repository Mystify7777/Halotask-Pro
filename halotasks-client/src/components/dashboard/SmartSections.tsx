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

export default function SmartSections({ tasks }: SmartSectionsProps) {
  const overdueCount = getOverdueTasks(tasks).length;
  const dueTodayCount = getDueTodayTasks(tasks).length;
  const upcomingCount = getUpcomingTasks(tasks).length;
  const completedTodayCount = getCompletedToday(tasks).length;
  const workloadMinutes = getEstimatedWorkload(tasks);

  return (
    <section className="smart-sections" aria-label="Productivity insights">
      <article className="insight-card overdue">
        <small>Overdue</small>
        <strong>{overdueCount}</strong>
      </article>
      <article className="insight-card due-today">
        <small>Due Today</small>
        <strong>{dueTodayCount}</strong>
      </article>
      <article className="insight-card upcoming">
        <small>Upcoming</small>
        <strong>{upcomingCount}</strong>
      </article>
      <article className="insight-card completed">
        <small>Completed Today</small>
        <strong>{completedTodayCount}</strong>
      </article>
      <article className="insight-card workload">
        <small>Workload Today</small>
        <strong>{workloadMinutes} min</strong>
      </article>
    </section>
  );
}
