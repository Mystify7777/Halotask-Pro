import { Priority } from '../../types/task';
import { FilterMode } from '../../hooks/useTaskFilters';
import { TASK_SORT_OPTIONS, TaskSortOption } from '../../hooks/useTaskSorting';

type TaskFiltersProps = {
  search: string;
  filterMode: FilterMode;
  priorityFilter: 'all' | Priority;
  sortBy: TaskSortOption;
  tagFilter: string | null;
  onSearchChange: (value: string) => void;
  onFilterModeChange: (value: FilterMode) => void;
  onPriorityFilterChange: (value: 'all' | Priority) => void;
  onSortByChange: (value: TaskSortOption) => void;
  onClearTagFilter: () => void;
};

export default function TaskFilters({
  search,
  filterMode,
  priorityFilter,
  sortBy,
  tagFilter,
  onSearchChange,
  onFilterModeChange,
  onPriorityFilterChange,
  onSortByChange,
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
        <select value={sortBy} onChange={(event) => onSortByChange(event.target.value as TaskSortOption)}>
          {TASK_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              Sort: {option.label}
            </option>
          ))}
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
