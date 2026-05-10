export default function TaskListSkeleton() {
  return (
    <ul className="task-list" aria-busy="true" aria-label="Loading tasks">
      {[1, 2, 3].map((i) => (
        <li key={i} className="task-skeleton" aria-hidden="true">
          <div className="skeleton-check" />
          <div className="skeleton-body">
            <div className="skeleton-line skeleton-title" />
            <div className="skeleton-line skeleton-meta" />
          </div>
        </li>
      ))}
    </ul>
  );
}
