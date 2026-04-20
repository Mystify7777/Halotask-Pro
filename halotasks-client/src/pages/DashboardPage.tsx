import { useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import BulkActionsBar from '../components/dashboard/BulkActionsBar';
import DashboardContent from '../components/dashboard/DashboardContent';
import DashboardSidebar from '../components/dashboard/DashboardSidebar';
import DashboardToolbar from '../components/dashboard/DashboardToolbar';
import GrowthTree from '../components/dashboard/GrowthTree';
import ReminderSettings from '../components/dashboard/ReminderSettings';
import SmartSections from '../components/dashboard/SmartSections';
import TaskCreateForm from '../components/dashboard/TaskCreateForm';
import TaskFilters from '../components/dashboard/TaskFilters';
import TaskList from '../components/dashboard/TaskList';
import { useDashboardGrowth } from '../hooks/useDashboardGrowth';
import { useDashboardReminders } from '../hooks/useDashboardReminders';
import { useDashboardSync } from '../hooks/useDashboardSync';
import type { SyncStatus } from '../hooks/useDashboardSync';
import { useDashboardTasks } from '../hooks/useDashboardTasks';
import { useNetworkStatus } from '../offline/network';
import type { Task } from '../types/task';

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

  const { isOnline } = useNetworkStatus();
  const { treeState, processGrowthForCompletion } = useDashboardGrowth();

  const tasksHook = useDashboardTasks({
    tasks,
    setTasks,
    isOnline,
    syncBridgeRef,
    processGrowthForCompletion,
    setStatusError,
    setStatusInfo,
  });

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
            />
          </>
        }
        growthPanel={treeState ? <GrowthTree state={treeState} /> : null}
      />

      <div className="panel">
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

        <DashboardContent
          smartSections={<SmartSections tasks={tasksHook.tasks} />}
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
            />
          }
        />
      </div>
    </section>
  );
}
