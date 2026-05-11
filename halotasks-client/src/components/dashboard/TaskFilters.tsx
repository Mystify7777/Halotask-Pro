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

const FILTER_MODES: { value: FilterMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'completed', label: 'Done' },
];

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
    <div className="filters-block" role="search" aria-label="Filter and search tasks">
      <input
        type="search"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
        placeholder="Search tasks"
        aria-label="Search tasks"
        className="filter-search"
      />

      {/* Status segment */}
      <div className="filter-segment" role="group" aria-label="Status filter">
        {FILTER_MODES.map(({ value, label }) => (
          <button
            key={value}
            type="button"
            className={filterMode === value ? 'segment-btn active' : 'segment-btn'}
            onClick={() => onFilterModeChange(value)}
            aria-pressed={filterMode === value}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="filter-row-selects">
        <select
          value={priorityFilter}
          onChange={(event) => onPriorityFilterChange(event.target.value as 'all' | Priority)}
          aria-label="Filter by priority"
        >
          <option value="all">All Priorities</option>
          <option value="low">Low</option>
          <option value="medium">Medium</option>
          <option value="high">High</option>
        </select>

        <select
          value={sortBy}
          onChange={(event) => onSortByChange(event.target.value as TaskSortOption)}
          aria-label="Sort tasks by"
        >
          {TASK_SORT_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              Sort: {option.label}
            </option>
          ))}
        </select>
      </div>

      {tagFilter && (
        <div className="active-filter-row" role="status" aria-live="polite">
          <span className="active-filter-chip">#{tagFilter}</span>
          <button type="button" className="ghost-btn btn-sm" onClick={onClearTagFilter}>
            Clear filter
          </button>
        </div>
      )}
    </div>
  );
}
