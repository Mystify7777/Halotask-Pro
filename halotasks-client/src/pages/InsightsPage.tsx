import { useCallback, useEffect, useMemo, useState } from 'react';
import GrowthTree from '../components/dashboard/GrowthTree';
import InsightModal from '../components/dashboard/InsightModal';
import { initTreeStorage } from '../growth/treeStorage';
import { getWeekHistory, type HistoryEntry, type WeekHistory } from '../offline/history';
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
  getWorkDoneToday,
} from '../utils/taskInsights';

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const formatMins = (mins: number) => (mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`);

type StatVariant = 'overdue' | 'due-today' | 'upcoming' | 'completed' | 'workload' | 'work-done' | 'neutral';
type ModalKey = 'overdue' | 'due-today' | 'upcoming' | 'completed' | null;

function StatCard({
  icon,
  label,
  value,
  variant,
  onClick,
}: {
  icon: string;
  label: string;
  value: string | number;
  variant: StatVariant;
  onClick?: () => void;
}) {
  if (onClick) {
    return (
      <button
        type="button"
        className={`insight-card ${variant}`}
        onClick={onClick}
        aria-label={`${label}: ${value} — click to view tasks`}
      >
        <span className="insight-icon" aria-hidden="true">{icon}</span>
        <small>{label}</small>
        <strong>{value}</strong>
      </button>
    );
  }

  return (
    <article className={`insight-card ${variant}`} aria-label={`${label}: ${value}`}>
      <span className="insight-icon" aria-hidden="true">{icon}</span>
      <small>{label}</small>
      <strong>{value}</strong>
    </article>
  );
}

function WeeklySummary({ history, treeState }: { history: WeekHistory; treeState: TreeState | null }) {
  const weekTotal = history.reduce((sum, entry) => sum + entry.completedCount, 0);
  const weekMins = history.reduce((sum, entry) => sum + entry.workDoneMinutes, 0);
  const streak = treeState?.streakDays ?? 0;

  const bestEntry = history.reduce<HistoryEntry | null>((best, entry) => {
    if (!best || entry.completedCount > best.completedCount) {
      return entry;
    }
    return best;
  }, null);

  const bestDayLabel = bestEntry && bestEntry.completedCount > 0
    ? DAY_LABELS[new Date(`${bestEntry.date}T12:00:00`).getDay()]
    : null;

  return (
    <div className="insights-weekly-summary">
      <div className="insights-weekly-chip">
        <span className="insights-weekly-chip-icon" aria-hidden="true">{streak >= 7 ? '🔥' : streak >= 3 ? '⚡' : '🌱'}</span>
        <div>
          <strong className="insights-weekly-chip-value">{streak} day{streak === 1 ? '' : 's'}</strong>
          <span className="insights-weekly-chip-label">streak</span>
        </div>
      </div>

      <div className="insights-weekly-chip">
        <span className="insights-weekly-chip-icon" aria-hidden="true">✅</span>
        <div>
          <strong className="insights-weekly-chip-value">{weekTotal}</strong>
          <span className="insights-weekly-chip-label">this week</span>
        </div>
      </div>

      <div className="insights-weekly-chip">
        <span className="insights-weekly-chip-icon" aria-hidden="true">⏱️</span>
        <div>
          <strong className="insights-weekly-chip-value">{formatMins(weekMins)}</strong>
          <span className="insights-weekly-chip-label">work done</span>
        </div>
      </div>

      {bestDayLabel && (
        <div className="insights-weekly-chip">
          <span className="insights-weekly-chip-icon" aria-hidden="true">🏆</span>
          <div>
            <strong className="insights-weekly-chip-value">{bestDayLabel}</strong>
            <span className="insights-weekly-chip-label">best day</span>
          </div>
        </div>
      )}
    </div>
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
              style={{ width: `${(counts[key] / total) * 100}%`, background: color }}
            />
          </div>
          <span className="breakdown-count">{counts[key]}</span>
        </div>
      ))}
    </div>
  );
}

function TagBreakdown({ tasks }: { tasks: Task[] }) {
  const active = tasks.filter((task) => !task.completed);
  const tagCounts = new Map<string, number>();

  for (const task of active) {
    for (const tag of task.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  if (tagCounts.size === 0) {
    return <p className="setting-desc">No tags on active tasks yet.</p>;
  }

  const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
  const max = sorted[0]?.[1] ?? 1;

  return (
    <div className="breakdown-grid" role="list" aria-label="Task tag distribution">
      {sorted.map(([tag, count]) => (
        <div key={tag} className="breakdown-row" role="listitem">
          <span className="breakdown-label">{tag}</span>
          <div className="breakdown-track" aria-hidden="true">
            <div
              className="breakdown-fill"
              style={{ width: `${(count / max) * 100}%`, background: 'var(--color-primary)', opacity: 0.75 }}
            />
          </div>
          <span className="breakdown-count">{count}</span>
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
        <span className="setting-label">Overall completion rate</span>
        <strong className="completion-rate-pct">{pct}%</strong>
      </div>
      <div className="breakdown-track" aria-label={`${pct}% of tasks completed`}>
        <div className="breakdown-fill" style={{ width: `${pct}%`, background: 'var(--color-success-border)' }} />
      </div>
      <p className="setting-desc">{completed} of {total} tasks completed all-time</p>
    </div>
  );
}

function PatternInsight({ history }: { history: WeekHistory }) {
  if (history.every((entry) => entry.completedCount === 0)) {
    return null;
  }

  const byDow = Array.from({ length: 7 }, () => ({ total: 0, days: 0 }));

  for (const entry of history) {
    const dow = new Date(`${entry.date}T12:00:00`).getDay();
    byDow[dow].total += entry.completedCount;
    byDow[dow].days += 1;
  }

  let bestDow = -1;
  let bestAvg = 0;

  for (let index = 0; index < 7; index += 1) {
    if (byDow[index].days === 0) {
      continue;
    }

    const avg = byDow[index].total / byDow[index].days;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestDow = index;
    }
  }

  if (bestDow === -1 || bestAvg < 1) {
    return null;
  }

  const todayDow = new Date().getDay();
  const isToday = bestDow === todayDow;

  return (
    <div className="insights-pattern" role="note">
      <span className="insights-pattern-icon" aria-hidden="true">💡</span>
      <p className="insights-pattern-text">
        {isToday ? (
          <>
            Today is your most productive day - <strong>{DAY_FULL[bestDow]}</strong>. Great time to tackle something big.
          </>
        ) : (
          <>
            You tend to complete the most tasks on <strong>{DAY_FULL[bestDow]}s</strong>. Use that momentum.
          </>
        )}
      </p>
    </div>
  );
}

function WeekHistoryChart({ history }: { history: WeekHistory }) {
  const [selected, setSelected] = useState<string | null>(history[history.length - 1]?.date ?? null);
  const todayKey = history[history.length - 1]?.date ?? '';
  const maxCount = Math.max(...history.map((entry) => entry.completedCount), 1);
  const entry = history.find((day) => day.date === selected) ?? null;

  return (
    <div className="week-history">
      <div className="week-history-bars" role="list" aria-label="7-day completion history">
        {history.map((day) => {
          const date = new Date(`${day.date}T12:00:00`);
          const dayLabel = DAY_LABELS[date.getDay()];
          const isToday = day.date === todayKey;
          const isActive = day.date === selected;
          const barPct = (day.completedCount / maxCount) * 100;

          return (
            <button
              key={day.date}
              type="button"
              role="listitem"
              className={`week-history-day${isActive ? ' active' : ''}${isToday ? ' today' : ''}`}
              onClick={() => setSelected(day.date === selected ? null : day.date)}
              aria-label={`${dayLabel}${isToday ? ' (today)' : ''}: ${day.completedCount} tasks`}
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

      {entry && (
        <div className="week-history-detail">
          <p className="week-history-detail-header">
            <strong>
              {entry.date === todayKey
                ? 'Today'
                : new Date(`${entry.date}T12:00:00`).toLocaleDateString(undefined, {
                    weekday: 'long',
                    month: 'short',
                    day: 'numeric',
                  })}
            </strong>
            {entry.workDoneMinutes > 0 && (
              <span className="week-history-time">⏱️ {formatMins(entry.workDoneMinutes)}</span>
            )}
          </p>

          {entry.completedTasks.length === 0 ? (
            <p className="setting-desc">No tasks completed this day.</p>
          ) : (
            <ul className="week-history-tasks">
              {entry.completedTasks.map((task) => (
                <li key={task.id} className="week-history-task">
                  <span className="week-history-task-check" aria-hidden="true">✓</span>
                  <span className="week-history-task-title">{task.title}</span>
                  {task.estimatedMinutes > 0 && (
                    <span className="week-history-task-time">{formatMins(task.estimatedMinutes)}</span>
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

export default function InsightsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [treeState, setTreeState] = useState<TreeState | null>(null);
  const [history, setHistory] = useState<WeekHistory>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<ModalKey>(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [tree, hist] = await Promise.all([initTreeStorage(), getWeekHistory()]);

      if (!cancelled) {
        setTreeState(tree);
        setHistory(hist);
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

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleTask = useCallback(async (task: Task) => {
    const updated = { ...task, completed: !task.completed };
    setTasks((prev) => prev.map((current) => (current._id === task._id ? updated : current)));

    try {
      await taskService.updateTask(task._id, { completed: updated.completed });
    } catch {
      setTasks((prev) => prev.map((current) => (current._id === task._id ? task : current)));
    }
  }, []);

  const overdueList = useMemo(() => getOverdueTasks(tasks), [tasks]);
  const dueTodayList = useMemo(() => getDueTodayTasks(tasks), [tasks]);
  const upcomingList = useMemo(() => getUpcomingTasks(tasks, 20), [tasks]);
  const completedTodayList = useMemo(() => getCompletedToday(tasks), [tasks]);
  const workloadMins = useMemo(() => getEstimatedWorkload(tasks), [tasks]);
  const workDoneMins = useMemo(() => getWorkDoneToday(tasks), [tasks]);

  const workloadLabel = workloadMins >= 60
    ? `${Math.floor(workloadMins / 60)}h ${workloadMins % 60}m`
    : `${workloadMins}m`;

  const workDoneLabel = workDoneMins >= 60
    ? `${Math.floor(workDoneMins / 60)}h ${workDoneMins % 60}m`
    : `${workDoneMins}m`;

  const modalConfig: Record<Exclude<ModalKey, null>, { title: string; tasks: Task[]; emptyMessage: string }> = {
    overdue: { title: 'Overdue tasks', tasks: overdueList, emptyMessage: 'No overdue tasks - great work!' },
    'due-today': { title: 'Due today', tasks: dueTodayList, emptyMessage: 'Nothing due today.' },
    upcoming: { title: 'Upcoming tasks', tasks: upcomingList, emptyMessage: 'No upcoming tasks with due dates.' },
    completed: { title: 'Completed today', tasks: completedTodayList, emptyMessage: 'No tasks completed today yet.' },
  };

  const activeModal = modal ? modalConfig[modal] : null;

  return (
    <div className="settings-page">
      {!loading && (history.length > 0 || treeState) && (
        <section className="settings-section panel">
          <h2>This week</h2>
          <WeeklySummary history={history} treeState={treeState} />
          <div style={{ marginTop: 'var(--space-4)' }}>
            <WeekHistoryChart history={history} />
          </div>
        </section>
      )}

      <section className="settings-section panel">
        <h2>Today at a glance</h2>
        {loading ? (
          <p className="setting-desc">Loading…</p>
        ) : (
          <div className="insights-stats-grid">
            <StatCard
              icon="⚠️"
              label="Overdue"
              value={overdueList.length}
              variant="overdue"
              onClick={overdueList.length > 0 ? () => setModal('overdue') : undefined}
            />
            <StatCard
              icon="📅"
              label="Due today"
              value={dueTodayList.length}
              variant="due-today"
              onClick={dueTodayList.length > 0 ? () => setModal('due-today') : undefined}
            />
            <StatCard
              icon="🔜"
              label="Upcoming"
              value={upcomingList.length}
              variant="upcoming"
              onClick={upcomingList.length > 0 ? () => setModal('upcoming') : undefined}
            />
            <StatCard
              icon="✅"
              label="Completed today"
              value={completedTodayList.length}
              variant="completed"
              onClick={completedTodayList.length > 0 ? () => setModal('completed') : undefined}
            />
            <StatCard icon="⏱️" label="Workload" value={workloadLabel} variant="workload" />
            <StatCard icon="📋" label="Work done today" value={workDoneLabel} variant="work-done" />
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
          <hr className="setting-divider" />
          <p className="setting-label" style={{ marginBottom: 'var(--space-2)' }}>
            Tags across active tasks
          </p>
          <TagBreakdown tasks={tasks} />
        </section>
      )}

      {!loading && <PatternInsight history={history} />}

      <section className="settings-section panel">
        <h2>Growth tree</h2>
        {treeState ? <GrowthTree state={treeState} /> : <p className="setting-desc">Loading…</p>}
      </section>

      {activeModal && (
        <InsightModal
          isOpen={true}
          title={activeModal.title}
          tasks={activeModal.tasks}
          emptyMessage={activeModal.emptyMessage}
          onClose={() => setModal(null)}
          onToggleTask={handleToggleTask}
        />
      )}
    </div>
  );
}