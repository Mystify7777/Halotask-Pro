import { useEffect, useState } from 'react';
import GrowthTree from '../components/dashboard/GrowthTree';
import { initTreeStorage } from '../growth/treeStorage';
import { getCachedTasks } from '../offline/cache';
import { taskService } from '../services/taskService';
import type { TreeState } from '../growth/treeTypes';
import type { Task } from '../types/task';
import {
  getCompletedToday,
  getDueTodayTasks,
  getEstimatedWorkload,
  getOverdueTasks,
  getUpcomingTasks,
} from '../utils/taskInsights';

function StatCard({
  icon,
  label,
  value,
  variant,
}: {
  icon: string;
  label: string;
  value: string | number;
  variant: 'overdue' | 'due-today' | 'upcoming' | 'completed' | 'workload' | 'neutral';
}) {
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

function PriorityBreakdown({ tasks }: { tasks: Task[] }) {
  const active = tasks.filter((task) => !task.completed);
  const counts = {
    high: active.filter((task) => task.priority === 'high').length,
    medium: active.filter((task) => task.priority === 'medium').length,
    low: active.filter((task) => task.priority === 'low').length,
  };
  const total = active.length || 1;

  const rows: { key: keyof typeof counts; label: string; color: string }[] = [
    { key: 'high', label: 'High', color: 'var(--color-danger-border)' },
    { key: 'medium', label: 'Medium', color: 'var(--color-warning-border)' },
    { key: 'low', label: 'Low', color: 'var(--color-info-border)' },
  ];

  return (
    <div className="breakdown-grid" role="list" aria-label="Task priority breakdown">
      {rows.map(({ key, label, color }) => (
        <div key={key} className="breakdown-row" role="listitem">
          <span className="breakdown-label">{label}</span>
          <div className="breakdown-track" aria-hidden="true">
            <div
              className="breakdown-fill"
              style={{
                width: `${(counts[key] / total) * 100}%`,
                background: color,
              }}
            />
          </div>
          <span className="breakdown-count">{counts[key]}</span>
        </div>
      ))}
    </div>
  );
}

function CompletionRate({ tasks }: { tasks: Task[] }) {
  const total = tasks.length;
  const completed = tasks.filter((task) => task.completed).length;
  const pct = total === 0 ? 0 : Math.round((completed / total) * 100);

  return (
    <div className="completion-rate">
      <div className="completion-rate-header">
        <span className="setting-label">Completion rate</span>
        <strong className="completion-rate-pct">{pct}%</strong>
      </div>
      <div className="breakdown-track" aria-label={`${pct}% of tasks completed`}>
        <div
          className="breakdown-fill"
          style={{
            width: `${pct}%`,
            background: 'var(--color-success-border)',
          }}
        />
      </div>
      <p className="setting-desc">{completed} of {total} tasks completed</p>
    </div>
  );
}

export default function InsightsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [treeState, setTreeState] = useState<TreeState | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const tree = await initTreeStorage();
      if (!cancelled) {
        setTreeState(tree);
      }

      try {
        const response = await taskService.getTasks();
        if (!cancelled) {
          setTasks(response.tasks);
        }
      } catch {
        const cached = await getCachedTasks();
        if (!cancelled) {
          setTasks(cached);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  const overdue = getOverdueTasks(tasks).length;
  const dueToday = getDueTodayTasks(tasks).length;
  const upcoming = getUpcomingTasks(tasks).length;
  const completedToday = getCompletedToday(tasks).length;
  const workloadMins = getEstimatedWorkload(tasks);
  const workloadLabel =
    workloadMins >= 60
      ? `${Math.floor(workloadMins / 60)}h ${workloadMins % 60}m`
      : `${workloadMins} min`;

  return (
    <div className="settings-page">
      <section className="settings-section panel">
        <h2>Today at a glance</h2>
        {loading ? (
          <p className="setting-desc">Loading…</p>
        ) : (
          <div className="insights-stats-grid">
            <StatCard icon="⚠️" label="Overdue" value={overdue} variant="overdue" />
            <StatCard icon="📅" label="Due today" value={dueToday} variant="due-today" />
            <StatCard icon="🔜" label="Upcoming" value={upcoming} variant="upcoming" />
            <StatCard icon="✅" label="Completed today" value={completedToday} variant="completed" />
            <StatCard icon="⏱️" label="Workload" value={workloadLabel} variant="workload" />
            <StatCard icon="📋" label="Total tasks" value={tasks.length} variant="neutral" />
          </div>
        )}
      </section>

      {!loading && tasks.length > 0 && (
        <section className="settings-section panel">
          <h2>Task breakdown</h2>
          <CompletionRate tasks={tasks} />
          <hr className="setting-divider" />
          <p className="setting-label" style={{ marginBottom: 'var(--space-2)' }}>
            Active tasks by priority
          </p>
          <PriorityBreakdown tasks={tasks} />
        </section>
      )}

      <section className="settings-section panel">
        <h2>Growth tree</h2>
        {treeState ? <GrowthTree state={treeState} /> : <p className="setting-desc">Loading…</p>}
      </section>
    </div>
  );
}
