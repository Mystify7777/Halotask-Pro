import type { Task } from '../../types/task';

/** Open tasks by priority and by tag: the current backlog, not a trend (it changes as tasks are added and finished). */

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
            <div className="breakdown-fill" style={{ width: `${(counts[key] / total) * 100}%`, background: color }} />
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
            <div className="breakdown-fill" style={{ width: `${(count / max) * 100}%`, background: 'var(--color-primary)', opacity: 0.75 }} />
          </div>
          <span className="breakdown-count">{count}</span>
        </div>
      ))}
    </div>
  );
}

export default function BacklogBreakdown({ tasks }: { tasks: Task[] }) {
  return (
    <section className="settings-section panel">
      <h2>Open tasks</h2>
      <p className="setting-label" style={{ marginBottom: 'var(--space-2)' }}>Active tasks by priority</p>
      <PriorityBreakdown tasks={tasks} />
      <hr className="setting-divider" />
      <p className="setting-label" style={{ marginBottom: 'var(--space-2)' }}>Tags across active tasks</p>
      <TagBreakdown tasks={tasks} />
    </section>
  );
}
