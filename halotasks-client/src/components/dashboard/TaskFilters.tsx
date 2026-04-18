import { Priority } from '../../types/task';
import { FilterMode } from '../../hooks/useTaskFilters';

type TaskFiltersProps = {
  search: string;
  filterMode: FilterMode;
  priorityFilter: 'all' | Priority;
  tagFilter: string | null;
  onSearchChange: (value: string) => void;
  onFilterModeChange: (value: FilterMode) => void;
  onPriorityFilterChange: (value: 'all' | Priority) => void;
  onClearTagFilter: () => void;
};

export default function TaskFilters({
  search,
  filterMode,
  priorityFilter,
  tagFilter,
  onSearchChange,
  onFilterModeChange,
  onPriorityFilterChange,
  onClearTagFilter,
}: TaskFiltersProps) {
  return (
    <>
      <div className="filter-row">
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Search tasks"
        />
        <select value={filterMode} onChange={(event) => onFilterModeChange(event.target.value as FilterMode)}>
          <option value="all">All</option>
          <option value="active">Active</option>
          <option value="completed">Completed</option>
        </select>
        <select
          value={priorityFilter}
          onChange={(event) => onPriorityFilterChange(event.target.value as 'all' | Priority)}
        >
          <option value="all">All Priorities</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>
      </div>

      {tagFilter && (
        <div className="active-filter-row">
          <span className="active-filter-chip">Filtering by tag: {tagFilter}</span>
          <button type="button" className="ghost-btn" onClick={onClearTagFilter}>
            Clear
          </button>
        </div>
      )}
    </>
  );
}
