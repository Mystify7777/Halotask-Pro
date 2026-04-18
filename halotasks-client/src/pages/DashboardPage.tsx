import { FormEvent, useEffect, useState } from 'react';
import { AxiosError } from 'axios';
import TaskCreateForm from '../components/dashboard/TaskCreateForm';
import TaskFilters from '../components/dashboard/TaskFilters';
import TaskList from '../components/dashboard/TaskList';
import BulkActionsBar from '../components/dashboard/BulkActionsBar';
import SmartSections from '../components/dashboard/SmartSections';
import { TaskEditState } from '../components/dashboard/types';
import { useTaskFilters, FilterMode } from '../hooks/useTaskFilters';
import { useTaskSelection } from '../hooks/useTaskSelection';
import { TaskSortOption, useTaskSorting } from '../hooks/useTaskSorting';
import { useTagSuggestions } from '../hooks/useTagSuggestions';
import { getCachedTasks, getLastSyncTimestamp, setCachedTasks, setLastSyncTimestamp } from '../offline/cache';
import { useNetworkStatus } from '../offline/network';
import { processSyncQueue } from '../offline/queueProcessor';
import { enqueueSyncAction, getSyncQueue } from '../offline/syncQueue';
import { taskService } from '../services/taskService';
import { Priority, Task, TaskCreatePayload } from '../types/task';
import { formatDateForInput } from '../utils/dateHelpers';
import { sanitizeTags, tryAddTag } from '../utils/tagHelpers';

type AddTagResult = {
  message: string | null;
};

type SyncStatus = 'cached' | 'syncing' | 'synced' | 'offline' | 'errors-pending';

type TaskUpdatePayload = Omit<Partial<TaskCreatePayload>, 'dueDate'> & {
  completed?: boolean;
  dueDate?: string | null;
};

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [creatingTask, setCreatingTask] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [activeActionTaskId, setActiveActionTaskId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [createTags, setCreateTags] = useState<string[]>([]);
  const [createTagInput, setCreateTagInput] = useState('');
  const [estimatedMinutes, setEstimatedMinutes] = useState('');

  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all');
  const [sortBy, setSortBy] = useState<TaskSortOption>('dueSoonest');
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<string | null>(null);
  const [, setBulkFailedTaskIds] = useState<string[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus>('syncing');
  const [lastSyncAt, setLastSyncAt] = useState<string | null>(null);

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editState, setEditState] = useState<TaskEditState | null>(null);

  const { isOnline } = useNetworkStatus();

  const { selectedIds, toggleSelect, clearSelection, selectAll, retainOnly } = useTaskSelection();

  const createTagSuggestions = useTagSuggestions(tasks, createTagInput, createTags);
  const editTagSuggestions = useTagSuggestions(tasks, editState?.tagInput ?? '', editState?.tags ?? []);

  const filteredTasks = useTaskFilters({
    tasks,
    search,
    filterMode,
    priorityFilter,
    tagFilter,
  });

  const sortedTasks = useTaskSorting(filteredTasks, sortBy);

  const visibleTaskIds = sortedTasks.map((task) => task._id);

  useEffect(() => {
    retainOnly(visibleTaskIds);
  }, [retainOnly, visibleTaskIds]);

  const selectedVisibleIds = selectedIds.filter((id) => visibleTaskIds.includes(id));
  const allVisibleSelected = visibleTaskIds.length > 0 && selectedVisibleIds.length === visibleTaskIds.length;

  const persistTasks = (updater: (current: Task[]) => Task[]) => {
    setTasks((current) => {
      const next = updater(current);
      void setCachedTasks(next);
      return next;
    });
  };

  const createOfflineTask = (payload: TaskCreatePayload): Task => {
    const now = new Date().toISOString();

    return {
      _id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId: 'local-user',
      title: payload.title,
      description: payload.description ?? '',
      completed: false,
      priority: payload.priority,
      tags: payload.tags ?? [],
      dueDate: payload.dueDate,
      estimatedMinutes: payload.estimatedMinutes ?? 0,
      reminderSent: false,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
  };

  const processPendingQueue = async () => {
    const queued = await getSyncQueue();

    if (queued.length === 0) {
      return {
        remaining: 0,
      };
    }

    setSyncStatus('syncing');

    const result = await processSyncQueue({
      onTaskCreated: (localTaskId, serverTask) => {
        persistTasks((current) =>
          current.map((task) => (task._id === localTaskId ? { ...serverTask, pendingSync: false } : task)),
        );
      },
      onTaskUpdated: (taskId, serverTask) => {
        persistTasks((current) =>
          current.map((task) => (task._id === taskId ? { ...serverTask, pendingSync: false } : task)),
        );
      },
      onTaskDeleted: (taskId) => {
        persistTasks((current) => current.filter((task) => task._id !== taskId));
      },
    });

    if (result.remaining > 0) {
      setSyncStatus('errors-pending');
      setStatusError(`${result.remaining} queued action${result.remaining === 1 ? '' : 's'} still pending sync.`);
    } else {
      setSyncStatus('synced');
    }

    return result;
  };

  const fetchFreshTasks = async () => {
    setSyncStatus('syncing');

    const response = await taskService.getTasks();
    const freshTasks = response.tasks.map((task) => ({ ...task, pendingSync: false }));
    setTasks(freshTasks);
    await setCachedTasks(freshTasks);

    const syncedAt = new Date().toISOString();
    await setLastSyncTimestamp(syncedAt);
    setLastSyncAt(syncedAt);
    setSyncStatus('synced');
  };

  const loadTasks = async () => {
    const cachedTasks = await getCachedTasks();
    const cachedSyncTime = await getLastSyncTimestamp();
    setLastSyncAt(cachedSyncTime);

    if (cachedTasks.length > 0) {
      setTasks(cachedTasks);
      setSyncStatus('cached');
      setLoadingTasks(false);
    }

    if (!isOnline) {
      setSyncStatus('offline');
      setLoadingTasks(false);
      return;
    }

    try {
      setStatusError(null);

      const queueResult = await processPendingQueue();

      if (queueResult.remaining > 0) {
        setLoadingTasks(false);
        return;
      }

      await fetchFreshTasks();
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      if (cachedTasks.length > 0) {
        setStatusError('Unable to sync latest tasks. Showing cached data.');
        setSyncStatus('cached');
      } else {
        setStatusError(axiosError.response?.data?.message ?? 'Unable to load tasks');
      }
    } finally {
      setLoadingTasks(false);
    }
  };

  useEffect(() => {
    setLoadingTasks(true);
    void loadTasks();
  }, [isOnline]);

  const addCreateTag = (rawTag: string): AddTagResult => {
    const result = tryAddTag(createTags, rawTag);
    setCreateTags(result.tags);

    if (result.message) {
      setStatusError(result.message);
    }

    return { message: result.message };
  };

  const removeCreateTag = (tag: string) => {
    setCreateTags((current) => current.filter((item) => item !== tag));
  };

  const addEditTag = (rawTag: string): AddTagResult => {
    if (!editState) {
      return { message: null };
    }

    const result = tryAddTag(editState.tags, rawTag);

    setEditState((current) =>
      current
        ? {
            ...current,
            tags: result.tags,
            tagInput: '',
          }
        : current,
    );

    if (result.message) {
      setStatusError(result.message);
    }

    return { message: result.message };
  };

  const removeEditTag = (tag: string) => {
    setEditState((current) =>
      current
        ? {
            ...current,
            tags: current.tags.filter((item) => item !== tag),
          }
        : current,
    );
  };

  const handleCreateTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatusError(null);
    setStatusInfo(null);

    if (!title.trim()) {
      return;
    }

    try {
      setCreatingTask(true);
      const parsedEstimatedMinutes = Number(estimatedMinutes);
      const payload: TaskCreatePayload = {
        title: title.trim(),
        priority,
        tags: sanitizeTags(createTags),
        dueDate: dueDate || undefined,
        estimatedMinutes:
          estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
            ? parsedEstimatedMinutes
            : undefined,
      };

      if (!isOnline) {
        const offlineTask = createOfflineTask(payload);
        persistTasks((current) => [offlineTask, ...current]);

        await enqueueSyncAction({
          type: 'create',
          taskId: offlineTask._id,
          payload,
        });

        setSyncStatus('offline');
        setStatusInfo('Task saved offline. Pending sync.');
        setTitle('');
        setPriority('medium');
        setDueDate('');
        setCreateTags([]);
        setCreateTagInput('');
        setEstimatedMinutes('');
        return;
      }

      const response = await taskService.createTask(payload);

      persistTasks((current) => [{ ...response.task, pendingSync: false }, ...current]);
      setTitle('');
      setPriority('medium');
      setDueDate('');
      setCreateTags([]);
      setCreateTagInput('');
      setEstimatedMinutes('');
      setStatusInfo('Task created successfully.');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to create task');
    } finally {
      setCreatingTask(false);
    }
  };

  const handleToggleTask = async (task: Task) => {
    setStatusError(null);
    setStatusInfo(null);

    const nextCompleted = !task.completed;

    if (!isOnline) {
      persistTasks((current) =>
        current.map((item) =>
          item._id === task._id
            ? {
                ...item,
                completed: nextCompleted,
                updatedAt: new Date().toISOString(),
                pendingSync: true,
              }
            : item,
        ),
      );

      await enqueueSyncAction({
        type: 'update',
        taskId: task._id,
        payload: { completed: nextCompleted },
      });

      setSyncStatus('offline');
      setStatusInfo('Task updated offline. Pending sync.');
      return;
    }

    try {
      setActiveActionTaskId(task._id);
      const response = await taskService.updateTask(task._id, { completed: nextCompleted });
      persistTasks((current) => current.map((item) => (item._id === task._id ? response.task : item)));
      setStatusInfo('Task completion updated.');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to update task');
    } finally {
      setActiveActionTaskId(null);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setStatusError(null);
    setStatusInfo(null);

    if (!isOnline) {
      persistTasks((current) => current.filter((task) => task._id !== taskId));

      await enqueueSyncAction({
        type: 'delete',
        taskId,
      });

      setSyncStatus('offline');
      setStatusInfo('Task deleted offline. Pending sync.');
      return;
    }

    try {
      setActiveActionTaskId(taskId);
      await taskService.deleteTask(taskId);
      persistTasks((current) => current.filter((task) => task._id !== taskId));
      setStatusInfo('Task deleted successfully.');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to delete task');
    } finally {
      setActiveActionTaskId(null);
    }
  };

  const handleClearCompleted = async () => {
    setStatusError(null);
    setStatusInfo(null);
    setBulkFailedTaskIds([]);

    const completedIds = tasks.filter((task) => task.completed).map((task) => task._id);

    if (completedIds.length === 0) {
      setStatusInfo('No completed tasks to clear.');
      return;
    }

    if (!isOnline) {
      persistTasks((current) => current.filter((task) => !completedIds.includes(task._id)));
      await Promise.all(
        completedIds.map((taskId) =>
          enqueueSyncAction({
            type: 'delete',
            taskId,
          }),
        ),
      );
      clearSelection();
      setSyncStatus('offline');
      setStatusInfo(`Cleared ${completedIds.length} completed task${completedIds.length === 1 ? '' : 's'} offline.`);
      return;
    }

    try {
      setBulkActionLoading(true);
      const results = await Promise.allSettled(completedIds.map((taskId) => taskService.deleteTask(taskId)));

      const deletedIds: string[] = [];
      const failedIds: string[] = [];

      results.forEach((result, index) => {
        const taskId = completedIds[index];

        if (result.status === 'fulfilled') {
          deletedIds.push(taskId);
        } else {
          failedIds.push(taskId);
        }
      });

      if (deletedIds.length > 0) {
        persistTasks((current) => current.filter((task) => !deletedIds.includes(task._id)));
      }

      setBulkFailedTaskIds(failedIds);

      if (deletedIds.length > 0) {
        setStatusInfo(`Cleared ${deletedIds.length} completed task${deletedIds.length === 1 ? '' : 's'}.`);
      }

      if (failedIds.length > 0) {
        setStatusError(`${failedIds.length} completed task${failedIds.length === 1 ? '' : 's'} failed to clear.`);
      }
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleMarkSelectedComplete = async () => {
    setStatusError(null);
    setStatusInfo(null);
    setBulkFailedTaskIds([]);

    if (selectedVisibleIds.length === 0) {
      return;
    }

    const selectedTasks = sortedTasks.filter((task) => selectedVisibleIds.includes(task._id));
    const incompleteTasks = selectedTasks.filter((task) => !task.completed);

    if (incompleteTasks.length === 0) {
      setStatusInfo('Selected tasks are already completed.');
      return;
    }

    if (!isOnline) {
      const incompleteIds = incompleteTasks.map((task) => task._id);

      persistTasks((current) =>
        current.map((task) =>
          incompleteIds.includes(task._id)
            ? {
                ...task,
                completed: true,
                updatedAt: new Date().toISOString(),
                pendingSync: true,
              }
            : task,
        ),
      );

      await Promise.all(
        incompleteIds.map((taskId) =>
          enqueueSyncAction({
            type: 'update',
            taskId,
            payload: { completed: true },
          }),
        ),
      );

      clearSelection();
      setSyncStatus('offline');
      setStatusInfo(`Marked ${incompleteIds.length} task${incompleteIds.length === 1 ? '' : 's'} complete offline.`);
      return;
    }

    try {
      setBulkActionLoading(true);
      const results = await Promise.allSettled(
        incompleteTasks.map((task) => taskService.updateTask(task._id, { completed: true })),
      );

      const updatedTasks: Task[] = [];
      const failedIds: string[] = [];

      results.forEach((result, index) => {
        const sourceTask = incompleteTasks[index];

        if (result.status === 'fulfilled') {
          updatedTasks.push(result.value.task);
        } else {
          failedIds.push(sourceTask._id);
        }
      });

      if (updatedTasks.length > 0) {
        const updatedById = new Map(updatedTasks.map((task) => [task._id, task]));
        persistTasks((current) => current.map((task) => updatedById.get(task._id) ?? task));
      }

      setBulkFailedTaskIds(failedIds);

      if (failedIds.length > 0) {
        selectAll(failedIds);
      } else {
        clearSelection();
      }

      if (updatedTasks.length > 0) {
        setStatusInfo(`Marked ${updatedTasks.length} task${updatedTasks.length === 1 ? '' : 's'} complete.`);
      }

      if (failedIds.length > 0) {
        setStatusError(`${failedIds.length} task${failedIds.length === 1 ? '' : 's'} failed to update.`);
      }
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleDeleteSelected = async () => {
    setStatusError(null);
    setStatusInfo(null);
    setBulkFailedTaskIds([]);

    if (selectedVisibleIds.length === 0) {
      return;
    }

    const confirmed = window.confirm(`Delete ${selectedVisibleIds.length} selected tasks?`);

    if (!confirmed) {
      return;
    }

    if (!isOnline) {
      persistTasks((current) => current.filter((task) => !selectedVisibleIds.includes(task._id)));
      await Promise.all(
        selectedVisibleIds.map((taskId) =>
          enqueueSyncAction({
            type: 'delete',
            taskId,
          }),
        ),
      );
      clearSelection();
      setSyncStatus('offline');
      setStatusInfo(`Deleted ${selectedVisibleIds.length} task${selectedVisibleIds.length === 1 ? '' : 's'} offline.`);
      return;
    }

    try {
      setBulkActionLoading(true);
      const results = await Promise.allSettled(selectedVisibleIds.map((taskId) => taskService.deleteTask(taskId)));

      const deletedIds: string[] = [];
      const failedIds: string[] = [];

      results.forEach((result, index) => {
        const taskId = selectedVisibleIds[index];

        if (result.status === 'fulfilled') {
          deletedIds.push(taskId);
        } else {
          failedIds.push(taskId);
        }
      });

      if (deletedIds.length > 0) {
        persistTasks((current) => current.filter((task) => !deletedIds.includes(task._id)));
      }

      setBulkFailedTaskIds(failedIds);

      if (failedIds.length > 0) {
        selectAll(failedIds);
      } else {
        clearSelection();
      }

      if (deletedIds.length > 0) {
        setStatusInfo(`Deleted ${deletedIds.length} task${deletedIds.length === 1 ? '' : 's'}.`);
      }

      if (failedIds.length > 0) {
        setStatusError(`${failedIds.length} task${failedIds.length === 1 ? '' : 's'} failed to delete.`);
      }
    } finally {
      setBulkActionLoading(false);
    }
  };

  const handleStartEditing = (task: Task) => {
    setEditingTaskId(task._id);
    setEditState({
      title: task.title,
      priority: task.priority,
      tags: sanitizeTags(task.tags),
      tagInput: '',
      dueDate: formatDateForInput(task.dueDate),
      estimatedMinutes: task.estimatedMinutes > 0 ? String(task.estimatedMinutes) : '',
    });
  };

  const handleCancelEditing = () => {
    setEditingTaskId(null);
    setEditState(null);
  };

  const handleSaveTaskEdit = async (taskId: string) => {
    if (!editState || !editState.title.trim()) {
      return;
    }

    setStatusError(null);
    setStatusInfo(null);

    const parsedEstimatedMinutes = Number(editState.estimatedMinutes);
    const payload: TaskUpdatePayload = {
      title: editState.title.trim(),
      priority: editState.priority,
      tags: sanitizeTags(editState.tags),
      dueDate: editState.dueDate || null,
      estimatedMinutes:
        editState.estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
          ? parsedEstimatedMinutes
          : 0,
    };

    if (!isOnline) {
      persistTasks((current) =>
        current.map((item) =>
          item._id === taskId
            ? {
                ...item,
                title: payload.title ?? item.title,
                priority: payload.priority ?? item.priority,
                tags: payload.tags ?? item.tags,
                dueDate: payload.dueDate ?? undefined,
                estimatedMinutes: payload.estimatedMinutes ?? item.estimatedMinutes,
                updatedAt: new Date().toISOString(),
                pendingSync: true,
              }
            : item,
        ),
      );

      await enqueueSyncAction({
        type: 'update',
        taskId,
        payload,
      });

      handleCancelEditing();
      setSyncStatus('offline');
      setStatusInfo('Task edit saved offline. Pending sync.');
      return;
    }

    try {
      setActiveActionTaskId(taskId);
      const response = await taskService.updateTask(taskId, payload);

      persistTasks((current) => current.map((item) => (item._id === taskId ? response.task : item)));
      handleCancelEditing();
      setStatusInfo('Task updated successfully.');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to update task');
    } finally {
      setActiveActionTaskId(null);
    }
  };

  return (
    <section className="dashboard-page">
      <div className="panel">
        <h2>Task Panel</h2>
        <p>Fast capture first, polish later.</p>
        <TaskCreateForm
          title={title}
          priority={priority}
          dueDate={dueDate}
          estimatedMinutes={estimatedMinutes}
          creatingTask={creatingTask}
          tags={createTags}
          tagInput={createTagInput}
          tagSuggestions={createTagSuggestions}
          onSubmit={handleCreateTask}
          onTitleChange={setTitle}
          onPriorityChange={setPriority}
          onDueDateChange={setDueDate}
          onEstimatedMinutesChange={setEstimatedMinutes}
          onTagInputChange={setCreateTagInput}
          onAddTag={addCreateTag}
          onRemoveTag={removeCreateTag}
        />
      </div>

      <div className="panel">
        <TaskFilters
          search={search}
          filterMode={filterMode}
          priorityFilter={priorityFilter}
          sortBy={sortBy}
          tagFilter={tagFilter}
          onSearchChange={setSearch}
          onFilterModeChange={setFilterMode}
          onPriorityFilterChange={setPriorityFilter}
          onSortByChange={setSortBy}
          onClearTagFilter={() => setTagFilter(null)}
        />

        <p className={`sync-status ${syncStatus}`}>
          Status:{' '}
          {syncStatus === 'offline'
            ? 'Offline'
            : syncStatus === 'syncing'
              ? 'Syncing'
              : syncStatus === 'cached'
                ? 'Cached'
                : syncStatus === 'errors-pending'
                  ? 'Errors Pending'
                  : 'Synced'}
          {lastSyncAt ? ` • Last sync ${new Date(lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}
        </p>

        <div className="inline-actions-row">
          <button type="button" className="ghost-btn" onClick={handleClearCompleted} disabled={bulkActionLoading}>
            Clear Completed
          </button>
        </div>

        {selectedVisibleIds.length > 0 && (
          <BulkActionsBar
            selectedCount={selectedVisibleIds.length}
            allVisibleSelected={allVisibleSelected}
            loading={bulkActionLoading}
            onSelectAllVisible={() => selectAll(visibleTaskIds)}
            onClearSelection={clearSelection}
            onMarkSelectedComplete={handleMarkSelectedComplete}
            onDeleteSelected={handleDeleteSelected}
          />
        )}

        {statusError && <p className="form-error">{statusError}</p>}
        {statusInfo && <p className="form-success">{statusInfo}</p>}

        <SmartSections tasks={tasks} />

        <TaskList
          tasks={sortedTasks}
          loadingTasks={loadingTasks}
          activeActionTaskId={activeActionTaskId}
          selectedIds={selectedVisibleIds}
          bulkActionLoading={bulkActionLoading}
          editingTaskId={editingTaskId}
          editState={editState}
          editTagSuggestions={editTagSuggestions}
          tagFilter={tagFilter}
          onEditStateChange={setEditState}
          onStartEditing={handleStartEditing}
          onCancelEditing={handleCancelEditing}
          onSaveTaskEdit={handleSaveTaskEdit}
          onToggleTask={handleToggleTask}
          onDeleteTask={handleDeleteTask}
          onToggleSelect={toggleSelect}
          onToggleTagFilter={(tag) => setTagFilter((current) => (current === tag ? null : tag))}
          onAddEditTag={addEditTag}
          onRemoveEditTag={removeEditTag}
        />
      </div>
    </section>
  );
}
