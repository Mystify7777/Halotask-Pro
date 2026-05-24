import { useEffect, useState } from 'react';
import GrowthTree from '../components/dashboard/GrowthTree';
import { initTreeStorage } from '../growth/treeStorage';
import { getWeekHistory, type WeekHistory, type HistoryEntry } from '../offline/history';
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

// ── Stat card ─────────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, variant }: {
  icon: string; label: string; value: string | number;
  variant: 'overdue' | 'due-today' | 'upcoming' | 'completed' | 'workload' | 'neutral';
}) {
  return (
    <article className={`insight-card ${variant}`} aria-label={`${label}: ${value}`}>
      <span className="insight-icon" aria-hidden="true">{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

// ── Priority breakdown ────────────────────────────────────────────────────────
function PriorityBreakdown({ tasks }: { tasks: Task[] }) {
  const active = tasks.filter((t) => !t.completed);
  const counts = {
    high:   active.filter((t) => t.priority === 'high').length,
    medium: active.filter((t) => t.priority === 'medium').length,
    low:    active.filter((t) => t.priority === 'low').length,
  };
  const total = active.length || 1;
  const rows: { key: keyof typeof counts; label: string; color: string }[] = [
    { key: 'high',   label: 'High',   color: 'var(--color-danger-border)'  },
    { key: 'medium', label: 'Medium', color: 'var(--color-warning-border)' },
    { key: 'low',    label: 'Low',    color: 'var(--color-info-border)'    },
  ];
  return (
    <div className="breakdown-grid" role="list" aria-label="Task priority breakdown">
      {rows.map(({ key, label, color }) => (
        <div key={key} className="breakdown-row" role="listitem">
          <span className="breakdown-label">{label}</span>
          <div className="breakdown-track" aria-hidden="true">
            <div className="breakdown-fill" style={{ width: `${(counts[key] / total) * 100}%`, background: color }} />
          </div>
          <span className="breakdown-count">{counts[key]}</span>
        </div>
      ))}
    </div>
  );
}

// ── Completion rate ───────────────────────────────────────────────────────────
function CompletionRate({ tasks }: { tasks: Task[] }) {
  const total     = tasks.length;
  const completed = tasks.filter((t) => t.completed).length;
  const pct       = total === 0 ? 0 : Math.round((completed / total) * 100);
  return (
    <div className="completion-rate">
      <div className="completion-rate-header">
        <span className="setting-label">Completion rate</span>
        <strong className="completion-rate-pct">{pct}%</strong>
      </div>
      <div className="breakdown-track" aria-label={`${pct}% of tasks completed`}>
        <div className="breakdown-fill" style={{ width: `${pct}%`, background: 'var(--color-success-border)' }} />
      </div>
      <p className="setting-desc">{completed} of {total} tasks completed</p>
    </div>
  );
}

// ── 7-day history ─────────────────────────────────────────────────────────────
const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const formatMins = (mins: number) =>
  mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;

function WeekHistoryChart({ history }: { history: WeekHistory }) {
  const [selected, setSelected] = useState<string | null>(
    history[history.length - 1]?.date ?? null,
  );

  const todayKey  = history[history.length - 1]?.date ?? '';
  const maxCount  = Math.max(...history.map((e) => e.completedCount), 1);
  const entry     = history.find((e) => e.date === selected);

  return (
    <div className="week-history">
      {/* Day bars */}
      <div className="week-history-bars" role="list" aria-label="7-day completion history">
        {history.map((day) => {
          const date     = new Date(day.date + 'T12:00:00'); // local noon avoids DST edge
          const dayLabel = DAY_LABELS[date.getDay()];
          const isToday  = day.date === todayKey;
          const isActive = day.date === selected;
          const barPct   = (day.completedCount / maxCount) * 100;

          return (
            <button
              key={day.date}
              type="button"
              role="listitem"
              className={`week-history-day${isActive ? ' active' : ''}${isToday ? ' today' : ''}`}
              onClick={() => setSelected(day.date === selected ? null : day.date)}
              aria-label={`${dayLabel}${isToday ? ' (today)' : ''}: ${day.completedCount} tasks completed`}
              aria-pressed={isActive}
            >
              <span className="week-history-bar-wrap">
                <span
                  className="week-history-bar"
                  style={{ height: `${Math.max(barPct, day.completedCount > 0 ? 8 : 2)}%` }}
                />
              </span>
              <span className="week-history-count">{day.completedCount}</span>
              <span className="week-history-label">{dayLabel}</span>
            </button>
          );
        })}
      </div>

      {/* Selected day task list */}
      {entry && (
        <div className="week-history-detail">
          <p className="week-history-detail-header">
            <strong>
              {entry.date === todayKey ? 'Today' : new Date(entry.date + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}
            </strong>
            {entry.workDoneMinutes > 0 && (
              <span className="week-history-time">⏱️ {formatMins(entry.workDoneMinutes)}</span>
            )}
          </p>

          {entry.completedTasks.length === 0 ? (
            <p className="setting-desc">No tasks completed this day.</p>
          ) : (
            <ul className="week-history-tasks">
              {entry.completedTasks.map((t) => (
                <li key={t.id} className="week-history-task">
                  <span className="week-history-task-check" aria-hidden="true">✓</span>
                  <span className="week-history-task-title">{t.title}</span>
                  {t.estimatedMinutes > 0 && (
                    <span className="week-history-task-time">{formatMins(t.estimatedMinutes)}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function InsightsPage() {
  const [tasks,    setTasks]    = useState<Task[]>([]);
  const [treeState, setTreeState] = useState<TreeState | null>(null);
  const [history,  setHistory]  = useState<WeekHistory>([]);
  const [loading,  setLoading]  = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [tree, hist] = await Promise.all([initTreeStorage(), getWeekHistory()]);
      if (!cancelled) { setTreeState(tree); setHistory(hist); }

      try {
        const res = await taskService.getTasks();
        if (!cancelled) setTasks(res.tasks);
      } catch {
        const cached = await getCachedTasks();
        if (!cancelled) setTasks(cached);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const overdue       = getOverdueTasks(tasks).length;
  const dueToday      = getDueTodayTasks(tasks).length;
  const upcoming      = getUpcomingTasks(tasks).length;
  const completedToday = getCompletedToday(tasks).length;
  const workloadMins  = getEstimatedWorkload(tasks);
  const workloadLabel = workloadMins >= 60
    ? `${Math.floor(workloadMins / 60)}h ${workloadMins % 60}m`
    : `${workloadMins} min`;

  return (
    <div className="settings-page">

      {/* Today at a glance */}
      <section className="settings-section panel">
        <h2>Today at a glance</h2>
        {loading ? <p className="setting-desc">Loading…</p> : (
          <div className="insights-stats-grid">
            <StatCard icon="⚠️" label="Overdue"          value={overdue}         variant="overdue"   />
            <StatCard icon="📅" label="Due today"         value={dueToday}        variant="due-today" />
            <StatCard icon="🔜" label="Upcoming"          value={upcoming}        variant="upcoming"  />
            <StatCard icon="✅" label="Completed today"   value={completedToday}  variant="completed" />
            <StatCard icon="⏱️" label="Workload"          value={workloadLabel}   variant="workload"  />
            <StatCard icon="📋" label="Total tasks"       value={tasks.length}    variant="neutral"   />
          </div>
        )}
      </section>

      {/* 7-day history */}
      <section className="settings-section panel">
        <h2>7-day history</h2>
        {history.length === 0
          ? <p className="setting-desc">No history yet — complete some tasks to see your streak here.</p>
          : <WeekHistoryChart history={history} />
        }
      </section>

      {/* Task breakdown */}
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

      {/* Growth tree */}
      <section className="settings-section panel">
        <h2>Growth tree</h2>
        {treeState ? <GrowthTree state={treeState} /> : <p className="setting-desc">Loading…</p>}
      </section>

    </div>
  );
}
