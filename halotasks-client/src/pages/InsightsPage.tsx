import { useCallback, useEffect, useMemo, useState } from 'react';
import BacklogBreakdown from '../components/insights/BacklogBreakdown';
import TrendSection from '../components/insights/TrendSection';
import GrowthTree from '../components/dashboard/GrowthTree';
import InsightModal from '../components/dashboard/InsightModal';
import { missingCompletionsNote } from '../insights/copy';
import type { TrendRange } from '../insights/trend';
import { invalidateTrendHistory, loadTrendHistory, type TrendHistory } from '../insights/trendHistory';
import { applyServerGrowth, initTreeStorage, TreeIdentityError } from '../growth/treeStorage';
import { makeCompletionTransition } from '../offline/completionEvents';
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

const DEFAULT_RANGE: TrendRange = 30;

export default function InsightsPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksLoading, setTasksLoading] = useState(true);
  const [treeState, setTreeState] = useState<TreeState | null>(null);
  const [history, setHistory] = useState<TrendHistory | null>(null);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [range, setRange] = useState<TrendRange>(DEFAULT_RANGE);
  const [modal, setModal] = useState<ModalKey>(null);

  // One loader for the trend series; the page reads "today" from it (Issue #48, D5). It never throws by contract; the catch
  // only covers a programming error, which is shown as a calm retry rather than a blank section.
  const refreshHistory = useCallback(async (isCurrent: () => boolean = () => true) => {
    try {
      const next = await loadTrendHistory();
      if (!isCurrent()) return;
      setHistory(next);
      setHistoryFailed(false);
    } catch (err) {
      console.error('[InsightsPage] History failed to load:', err);
      if (isCurrent()) setHistoryFailed(true);
    }
  }, []);

  const retryHistory = useCallback(() => {
    invalidateTrendHistory();
    setHistoryFailed(false);
    setHistory(null);
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    let cancelled = false;
    const isCurrent = () => !cancelled;

    // initTreeStorage() rejects with TreeIdentityError when there is no authenticated
    // user or the account changed mid-init. Show no tree rather than a stale or
    // shared one; the rest of the page still loads.
    async function loadTree() {
      try {
        const tree = await initTreeStorage();
        if (isCurrent()) setTreeState(tree);
      } catch (err) {
        if (err instanceof TreeIdentityError) {
          console.warn('[InsightsPage] Growth Tree init skipped:', err.message);
        } else {
          console.error('[InsightsPage] Growth Tree init failed:', err);
        }
      }
    }

    async function loadTasks() {
      try {
        const response = await taskService.getTasks();
        if (isCurrent()) setTasks(response.tasks);
      } catch {
        const cached = await getCachedTasks();
        if (isCurrent()) setTasks(cached);
      } finally {
        if (isCurrent()) setTasksLoading(false);
      }
    }

    // Independent branches: a slow history request must not hold back the task cards, and the reverse.
    void loadTree();
    void loadTasks();
    void refreshHistory(isCurrent);

    return () => {
      cancelled = true;
    };
  }, [refreshHistory]);

  // The same completion transition as the dashboard checkbox (Issue #47): the event is made from the task as it is now and
  // rides the write, so this page records a completion exactly like every other writer. It is still online-only.
  const handleToggleTask = useCallback(async (task: Task) => {
    const transition = makeCompletionTransition(task);
    const updated = { ...task, ...transition.localPatch };
    setTasks((prev) => prev.map((current) => (current._id === task._id ? updated : current)));

    try {
      const response = await taskService.updateTask(task._id, { completed: transition.completed, completionEvent: transition.event });
      // Adopt the pointer the server holds, so the next toggle names the completion this one made.
      setTasks((prev) =>
        prev.map((current) =>
          current._id === task._id
            ? { ...current, completionId: response.task.completionId ?? current.completionId, completedAt: response.task.completedAt ?? current.completedAt }
            : current,
        ),
      );
      if (response.growth) {
        // The server awarded (or reconciled) this completion: show its tree, not a local guess.
        try {
          setTreeState(applyServerGrowth(response.growth));
        } catch (err) {
          console.warn('[InsightsPage] Server growth not applied:', err);
        }
      }
      // A completion changed history: the trend (and today's numbers, which come from it) must be read again.
      invalidateTrendHistory();
      void refreshHistory();
    } catch {
      setTasks((prev) => prev.map((current) => (current._id === task._id ? task : current)));
    }
  }, [refreshHistory]);

  const overdueList = useMemo(() => getOverdueTasks(tasks), [tasks]);
  const dueTodayList = useMemo(() => getDueTodayTasks(tasks), [tasks]);
  const upcomingList = useMemo(() => getUpcomingTasks(tasks, 20), [tasks]);
  const completedTodayList = useMemo(() => getCompletedToday(tasks), [tasks]);
  const workloadMins = useMemo(() => getEstimatedWorkload(tasks), [tasks]);
  const workDoneMins = useMemo(() => getWorkDoneToday(tasks), [tasks]);

  // ONE source for "today" on this page (decision D5): the last point of the trend series, the same number the chart's
  // last bar shows. Only while the series has not loaded (or holds nothing) does the card fall back to the live task list.
  const todayPoint = history && history.points.length > 0 ? history.points[history.points.length - 1] : null;
  const completedTodayCount = todayPoint ? todayPoint.completed : completedTodayList.length;
  const workDoneTodayMins = todayPoint ? todayPoint.minutes : workDoneMins;

  const workloadLabel = formatMins(workloadMins);
  const workDoneTodayLabel = formatMins(Math.round(workDoneTodayMins));

  const modalConfig: Record<Exclude<ModalKey, null>, { title: string; tasks: Task[]; emptyMessage: string; footnote?: string | null }> = {
    overdue: { title: 'Overdue tasks', tasks: overdueList, emptyMessage: 'No overdue tasks - great work!' },
    'due-today': { title: 'Due today', tasks: dueTodayList, emptyMessage: 'Nothing due today.' },
    upcoming: { title: 'Upcoming tasks', tasks: upcomingList, emptyMessage: 'No upcoming tasks with due dates.' },
    completed: {
      title: 'Completed today',
      tasks: completedTodayList,
      emptyMessage: 'No tasks completed today yet.',
      // The count comes from history, the list from the tasks that still exist: say so when history holds more.
      footnote: todayPoint ? missingCompletionsNote(completedTodayCount, completedTodayList.length) : null,
    },
  };

  const activeModal = modal ? modalConfig[modal] : null;

  return (
    <div className="settings-page insights-page">
      <TrendSection history={history} failed={historyFailed} range={range} onRangeChange={setRange} onRetry={retryHistory} />

      <section className="settings-section panel">
        <h2>Today at a glance</h2>
        {tasksLoading ? (
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
              value={completedTodayCount}
              variant="completed"
              onClick={completedTodayCount > 0 || completedTodayList.length > 0 ? () => setModal('completed') : undefined}
            />
            <StatCard icon="⏱️" label="Workload" value={workloadLabel} variant="workload" />
            <StatCard icon="📋" label="Work done today" value={workDoneTodayLabel} variant="work-done" />
          </div>
        )}
      </section>

      {!tasksLoading && tasks.length > 0 && <BacklogBreakdown tasks={tasks} />}

      {/* GrowthTree renders its own heading (it is shared with the dashboard), so the section is only labelled here. */}
      <section className="settings-section panel" aria-label="Growth tree">
        {treeState ? <GrowthTree state={treeState} /> : <p className="setting-desc">Loading…</p>}
      </section>

      {activeModal && (
        <InsightModal
          isOpen={true}
          title={activeModal.title}
          tasks={activeModal.tasks}
          emptyMessage={activeModal.emptyMessage}
          footnote={activeModal.footnote}
          onClose={() => setModal(null)}
          onToggleTask={handleToggleTask}
        />
      )}
    </div>
  );
}
