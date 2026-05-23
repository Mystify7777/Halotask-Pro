import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useLocation } from 'react-router-dom';
import BulkActionsBar from '../components/dashboard/BulkActionsBar';
import DashboardContent from '../components/dashboard/DashboardContent';
import DashboardSidebar from '../components/dashboard/DashboardSidebar';
import DashboardToolbar from '../components/dashboard/DashboardToolbar';
import GrowthTree from '../components/dashboard/GrowthTree';
import ReminderSettings from '../components/dashboard/ReminderSettings';
import SmartSections from '../components/dashboard/SmartSections';
import CompletedSection from '../components/dashboard/CompletedSection';
import TaskCreateForm from '../components/dashboard/TaskCreateForm';
import TaskCreateSheet from '../components/dashboard/TaskCreateSheet';
import GrowthTreeSheet from '../components/dashboard/GrowthTreeSheet';
import { useRegisterOrbTap, useUpdateOrbData } from '../components/AppLayout';
import TaskFilters from '../components/dashboard/TaskFilters';
import TaskList from '../components/dashboard/TaskList';
import { getStageDescription, getStageProgressForXp } from '../growth/treeLogic';
import { useDashboardGrowth } from '../hooks/useDashboardGrowth';
import { useDashboardReminders } from '../hooks/useDashboardReminders';
import { useDashboardSync } from '../hooks/useDashboardSync';
import type { SyncStatus } from '../hooks/useDashboardSync';
import { useDashboardTasks } from '../hooks/useDashboardTasks';
import { useNetworkStatus } from '../offline/network';
import type { Task } from '../types/task';

function getTaskEmptyStateContent({
  totalTasks,
  search,
  filterMode,
  priorityFilter,
  tagFilter,
}: {
  totalTasks: number;
  search: string;
  filterMode: string;
  priorityFilter: string;
  tagFilter: string | null;
}) {
  if (totalTasks === 0) {
    return {
      title: 'No tasks yet',
      message: 'Create your first task to get started.',
    };
  }

  const activeFilters: string[] = [];

  if (search.trim()) {
    activeFilters.push(`search "${search.trim()}"`);
  }

  if (filterMode !== 'all') {
    activeFilters.push(filterMode === 'active' ? 'active tasks' : 'completed tasks');
  }

  if (priorityFilter !== 'all') {
    activeFilters.push(`${priorityFilter} priority`);
  }

  if (tagFilter) {
    activeFilters.push(`tag "${tagFilter}"`);
  }

  if (activeFilters.length === 0) {
    return {
      title: 'No tasks available',
      message: 'Refresh the page or create a new task to continue.',
    };
  }

  return {
    title: 'No tasks match your filters.',
    message: `Try clearing ${activeFilters.join(', ')} to see tasks again.`,
  };
}

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<string | null>(null);

  const tasksRef = useRef<Task[]>([]);
  const syncBridgeRef = useRef<{
    setSyncStatus: Dispatch<SetStateAction<SyncStatus>>;
    refreshPendingQueueCount: () => Promise<number>;
  }>({
    setSyncStatus: () => undefined,
    refreshPendingQueueCount: async () => 0,
  });

  const location = useLocation();
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  const [isGrowthSheetOpen, setIsGrowthSheetOpen] = useState(false);

  // Register orb-tap handler — AppLayout calls this when the orb is tapped.
  // On desktop the sheet is display:none via CSS; on mobile it slides up.
  useRegisterOrbTap(() => setIsGrowthSheetOpen(true));

  // FAB navigates here with { openCreate: true } — open the sheet on mobile
  useEffect(() => {
    if ((location.state as { openCreate?: boolean } | null)?.openCreate) {
      setIsSheetOpen(true);
      // Clear the router state so a back/forward doesn't re-open the sheet
      window.history.replaceState({}, '', location.pathname);
    }
  }, [location.state, location.pathname]);

  const { isOnline } = useNetworkStatus();
  const { treeState, processGrowthForCompletion } = useDashboardGrowth();

  const orbTreeData = treeState
    ? (() => {
        const progress = getStageProgressForXp(treeState.xp);
        return {
          xp: treeState.xp,
          stage: getStageDescription(treeState.stage),
          xpToNext: progress.xpToNextStage,
          progressPct: progress.progressPercent,
        };
      })()
    : { xp: 0, stage: 'Seed', xpToNext: 100, progressPct: 0 };
  useUpdateOrbData(orbTreeData);

  const tasksHook = useDashboardTasks({
    tasks,
    setTasks,
    isOnline,
    syncBridgeRef,
    processGrowthForCompletion,
    setStatusError,
    setStatusInfo,
  });

  const titleInputRef = useRef<HTMLInputElement | null>(null);

  const handleAddTask = () => {
    const isDesktop = window.matchMedia('(min-width: 768px)').matches;
    if (isDesktop) {
      titleInputRef.current?.focus();
      return;
    }
    setIsSheetOpen(true);
  };

  useEffect(() => {
    tasksRef.current = tasksHook.tasks;
  }, [tasksHook.tasks]);

  const sync = useDashboardSync({
    isOnline,
    persistTasks: tasksHook.persistTasks,
    setLoadingTasks,
    setStatusError,
    setStatusInfo,
    setTasks: tasksHook.setTasks,
  });

  syncBridgeRef.current.setSyncStatus = sync.setSyncStatus;
  syncBridgeRef.current.refreshPendingQueueCount = sync.refreshPendingQueueCount;

  const reminders = useDashboardReminders({
    getTasks: () => tasksRef.current,
    setStatusInfo,
    setStatusError,
  });

  // Close sheet and reset form fields after a successful create
  const handleSheetSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    tasksHook.handleCreateTask(e);
    // handleCreateTask is async; close the sheet optimistically —
    // if the create fails the form fields remain populated.
    setIsSheetOpen(false);
  };

  const taskEmptyState = getTaskEmptyStateContent({
    totalTasks: tasksHook.tasks.length,
    search: tasksHook.search,
    filterMode: tasksHook.filterMode,
    priorityFilter: tasksHook.priorityFilter,
    tagFilter: tasksHook.tagFilter,
  });

  return (
    <section className="dashboard-page">
      <DashboardSidebar
        taskPanel={
          <>
            <h2>Task Panel</h2>
            <p>Fast capture first, polish later.</p>
            <TaskCreateForm
              title={tasksHook.title}
              priority={tasksHook.priority}
              dueDate={tasksHook.dueDate}
              estimatedMinutes={tasksHook.estimatedMinutes}
              creatingTask={tasksHook.creatingTask}
              tags={tasksHook.createTags}
              tagInput={tasksHook.createTagInput}
              tagSuggestions={tasksHook.createTagSuggestions}
              onSubmit={tasksHook.handleCreateTask}
              onTitleChange={tasksHook.setTitle}
              onPriorityChange={tasksHook.setPriority}
              onDueDateChange={tasksHook.setDueDate}
              onEstimatedMinutesChange={tasksHook.setEstimatedMinutes}
              onTagInputChange={tasksHook.setCreateTagInput}
              onAddTag={tasksHook.addCreateTag}
              onRemoveTag={tasksHook.removeCreateTag}
              inputRef={titleInputRef}
            />
          </>
        }
        growthPanel={treeState ? <GrowthTree state={treeState} /> : null}
      />

      {/* main-column keeps toolbar + content as one grid child,
          so dashboard-page grid sees: [sidebar] [main-column] */}
      <div className="main-column">
      <DashboardToolbar
        filters={
            <TaskFilters
            search={tasksHook.search}
            filterMode={tasksHook.filterMode}
            priorityFilter={tasksHook.priorityFilter}
            sortBy={tasksHook.sortBy}
            tagFilter={tasksHook.tagFilter}
              onSearchChange={tasksHook.setSearch}
              onFilterModeChange={tasksHook.setFilterMode}
              onPriorityFilterChange={tasksHook.setPriorityFilter}
              onSortByChange={tasksHook.setSortBy}
              onClearTagFilter={() => tasksHook.setTagFilter(null)}
              onAddTask={handleAddTask}
          />
        }
        syncArea={
          <div className="sync-status-row">
            <p className={`sync-status ${sync.syncStatus}`}>
              Status:{' '}
              {sync.syncStatus === 'offline'
                ? 'Offline'
                : sync.syncStatus === 'syncing'
                  ? 'Syncing'
                  : sync.syncStatus === 'cached'
                    ? 'Cached'
                    : sync.syncStatus === 'errors-pending'
                      ? `Errors Pending (${sync.pendingQueueCount})`
                      : 'Synced'}
              {sync.lastSyncAt
                ? ` • Last sync ${new Date(sync.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                : ''}
            </p>
            <ReminderSettings
              isOpen={reminders.isReminderSettingsOpen}
              settings={reminders.reminderSettings}
              onToggleOpen={() => reminders.setIsReminderSettingsOpen((current) => !current)}
              onSettingsChange={reminders.handleReminderSettingsChange}
            />
            {reminders.remindersSupported && reminders.notificationPermission === 'default' && (
              <button
                type="button"
                className="ghost-btn retry-sync-btn"
                onClick={reminders.handleEnableReminders}
                disabled={sync.syncStatus === 'syncing' || loadingTasks}
              >
                Enable Reminders
              </button>
            )}
            {reminders.remindersSupported && reminders.notificationPermission === 'denied' && (
              <span className="reminder-permission-note">Reminders blocked by browser settings.</span>
            )}
            {(sync.syncStatus === 'errors-pending' || sync.retryingSync) && (
              <button
                type="button"
                className="ghost-btn retry-sync-btn"
                onClick={sync.handleRetrySync}
                disabled={sync.syncStatus === 'syncing' || sync.retryingSync || loadingTasks}
              >
                Retry Sync
              </button>
            )}
          </div>
        }
        inlineActions={
          <div className="inline-actions-row">
            <button
              type="button"
              className="ghost-btn"
              onClick={tasksHook.handleClearCompleted}
              disabled={tasksHook.bulkActionLoading}
            >
              Clear Completed
            </button>
          </div>
        }
        bulkActions={
          tasksHook.selectedVisibleIds.length > 0 ? (
            <BulkActionsBar
              selectedCount={tasksHook.selectedVisibleIds.length}
              allVisibleSelected={tasksHook.allVisibleSelected}
              loading={tasksHook.bulkActionLoading}
              onSelectAllVisible={() => tasksHook.selectAll(tasksHook.visibleTaskIds)}
              onClearSelection={tasksHook.clearSelection}
              onMarkSelectedComplete={tasksHook.handleMarkSelectedComplete}
              onDeleteSelected={tasksHook.handleDeleteSelected}
            />
          ) : null
        }
        statusMessages={
          <>
            {statusError && <p className="form-error">{statusError}</p>}
            {statusInfo && <p className="form-success">{statusInfo}</p>}
          </>
        }
      />

      <div className="panel">
        <DashboardContent
          smartSections={<SmartSections tasks={tasksHook.tasks} onToggleTask={tasksHook.handleToggleTask} />}
          taskList={
            <TaskList
              tasks={tasksHook.sortedTasks}
              loadingTasks={loadingTasks}
              activeActionTaskId={tasksHook.activeActionTaskId}
              selectedIds={tasksHook.selectedVisibleIds}
              bulkActionLoading={tasksHook.bulkActionLoading}
              editingTaskId={tasksHook.editingTaskId}
              editState={tasksHook.editState}
              editTagSuggestions={tasksHook.editTagSuggestions}
              tagFilter={tasksHook.tagFilter}
              onEditStateChange={tasksHook.setEditState}
              onStartEditing={tasksHook.handleStartEditing}
              onCancelEditing={tasksHook.handleCancelEditing}
              onSaveTaskEdit={tasksHook.handleSaveTaskEdit}
              onToggleTask={tasksHook.handleToggleTask}
              onDeleteTask={tasksHook.handleDeleteTask}
              onToggleSelect={tasksHook.toggleSelect}
              onToggleTagFilter={(tag) => tasksHook.setTagFilter((current) => (current === tag ? null : tag))}
              onAddEditTag={tasksHook.addEditTag}
              onRemoveEditTag={tasksHook.removeEditTag}
              emptyStateTitle={taskEmptyState.title}
              emptyStateMessage={taskEmptyState.message}
            />
          }
        />

        <CompletedSection
          tasks={tasksHook.tasks.filter((task) => task.completed)}
          onToggleTask={tasksHook.handleToggleTask}
          onDeleteTask={tasksHook.handleDeleteTask}
        />
      </div>

      </div> {/* end main-column */}

      {/* Mobile-only sheet — CSS hides it at 768px+ where sidebar form is used */}
      <TaskCreateSheet
        isOpen={isSheetOpen}
        onClose={() => setIsSheetOpen(false)}
        title={tasksHook.title}
        priority={tasksHook.priority}
        dueDate={tasksHook.dueDate}
        estimatedMinutes={tasksHook.estimatedMinutes}
        creatingTask={tasksHook.creatingTask}
        tags={tasksHook.createTags}
        tagInput={tasksHook.createTagInput}
        tagSuggestions={tasksHook.createTagSuggestions}
        onSubmit={handleSheetSubmit}
        onTitleChange={tasksHook.setTitle}
        onPriorityChange={tasksHook.setPriority}
        onDueDateChange={tasksHook.setDueDate}
        onEstimatedMinutesChange={tasksHook.setEstimatedMinutes}
        onTagInputChange={tasksHook.setCreateTagInput}
        onAddTag={tasksHook.addCreateTag}
        onRemoveTag={tasksHook.removeCreateTag}
        inputRef={titleInputRef}
      />

      {/* Mobile-only sheet — CSS hides it at 768px+ where sidebar form is used */}
      {treeState && (
        <GrowthTreeSheet
          isOpen={isGrowthSheetOpen}
          onClose={() => setIsGrowthSheetOpen(false)}
          treeState={treeState}
        />
      )}
    </section>
  );
}
