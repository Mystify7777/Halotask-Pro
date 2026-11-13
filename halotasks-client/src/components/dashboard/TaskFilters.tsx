import { Priority } from '../../types/task';
import { FilterMode } from '../../hooks/useTaskFilters';
import { TASK_SORT_OPTIONS, TaskSortOption } from '../../hooks/useTaskSorting';
import DisclosureToggle from '../shared/DisclosureToggle';

type TaskFiltersProps = {
  search: string;
  filterMode: FilterMode;
  priorityFilter: 'all' | Priority;
  sortBy: TaskSortOption;
  tagFilter: string | null;
  filtersExpanded: boolean;
  summaryExpanded?: boolean;
  onSummaryExpandedChange?: (value: boolean) => void;
  onSearchChange: (value: string) => void;
  onFilterModeChange: (value: FilterMode) => void;
  onPriorityFilterChange: (value: 'all' | Priority) => void;
  onSortByChange: (value: TaskSortOption) => void;
  onClearTagFilter: () => void;
  onFiltersExpandedChange: (value: boolean) => void;
  onAddTask?: () => void;
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
  filtersExpanded,
  summaryExpanded = false,
  onSummaryExpandedChange,
  onSearchChange,
  onFilterModeChange,
  onPriorityFilterChange,
  onSortByChange,
  onClearTagFilter,
  onFiltersExpandedChange,
  onAddTask,
}: TaskFiltersProps) {
  const hasActiveFilters =
    priorityFilter !== 'all' ||
    sortBy !== 'dueSoonest' ||
    tagFilter !== null;

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

      {/* Segment + CTA row */}
      <div className="filter-segment-row">
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

        <div className="filter-segment-actions">
          <DisclosureToggle
            label="Filters"
            expanded={filtersExpanded}
            onToggle={() => onFiltersExpandedChange(!filtersExpanded)}
            controls="filter-advanced-panel"
            attention={hasActiveFilters ? 'Filters are active' : undefined}
          />

          {onSummaryExpandedChange && (
            <DisclosureToggle
              label="Summary"
              expanded={summaryExpanded}
              onToggle={() => onSummaryExpandedChange(!summaryExpanded)}
              // The panel is only in the page while it is open.
              controls={summaryExpanded ? 'summary-panel' : undefined}
            />
          )}

          {onAddTask && (
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={onAddTask}
              aria-label="Add new task"
            >
              + New task
            </button>
          )}
        </div>
      </div>

      {/* Collapsible advanced filters */}
      <div
        id="filter-advanced-panel"
        className={`filter-advanced${filtersExpanded ? ' filter-advanced--open' : ''}`}
        aria-hidden={!filtersExpanded}
        // A collapsed panel is clipped, not removed: inert keeps its controls out of the tab order and the accessibility tree.
        inert={!filtersExpanded}
      >
        <div className="filter-advanced-inner">
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
      </div>
    </div>
  );
}
