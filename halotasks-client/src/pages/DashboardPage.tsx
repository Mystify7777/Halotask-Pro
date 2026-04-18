import { FormEvent, useEffect, useState } from 'react';
import { AxiosError } from 'axios';
import TaskCreateForm from '../components/dashboard/TaskCreateForm';
import TaskFilters from '../components/dashboard/TaskFilters';
import TaskList from '../components/dashboard/TaskList';
import BulkActionsBar from '../components/dashboard/BulkActionsBar';
import { TaskEditState } from '../components/dashboard/types';
import { useTaskFilters, FilterMode } from '../hooks/useTaskFilters';
import { useTaskSelection } from '../hooks/useTaskSelection';
import { TaskSortOption, useTaskSorting } from '../hooks/useTaskSorting';
import { useTagSuggestions } from '../hooks/useTagSuggestions';
import { taskService } from '../services/taskService';
import { Priority, Task } from '../types/task';
import { formatDateForInput } from '../utils/dateHelpers';
import { sanitizeTags, tryAddTag } from '../utils/tagHelpers';

type AddTagResult = {
  message: string | null;
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

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editState, setEditState] = useState<TaskEditState | null>(null);

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

  const loadTasks = async () => {
    try {
      setLoadingTasks(true);
      setStatusError(null);
      const response = await taskService.getTasks();
      setTasks(response.tasks);
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to load tasks');
    } finally {
      setLoadingTasks(false);
    }
  };

  useEffect(() => {
    void loadTasks();
  }, []);

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

      const response = await taskService.createTask({
        title: title.trim(),
        priority,
        tags: sanitizeTags(createTags),
        dueDate: dueDate || undefined,
        estimatedMinutes:
          estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
            ? parsedEstimatedMinutes
            : undefined,
      });

      setTasks((current) => [response.task, ...current]);
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

    try {
      setActiveActionTaskId(task._id);
      const response = await taskService.updateTask(task._id, { completed: !task.completed });
      setTasks((current) => current.map((item) => (item._id === task._id ? response.task : item)));
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

    try {
      setActiveActionTaskId(taskId);
      await taskService.deleteTask(taskId);
      setTasks((current) => current.filter((task) => task._id !== taskId));
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
        setTasks((current) => current.filter((task) => !deletedIds.includes(task._id)));
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
        setTasks((current) => current.map((task) => updatedById.get(task._id) ?? task));
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
        setTasks((current) => current.filter((task) => !deletedIds.includes(task._id)));
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

    try {
      setActiveActionTaskId(taskId);
      const parsedEstimatedMinutes = Number(editState.estimatedMinutes);

      const response = await taskService.updateTask(taskId, {
        title: editState.title.trim(),
        priority: editState.priority,
        tags: sanitizeTags(editState.tags),
        dueDate: editState.dueDate || null,
        estimatedMinutes:
          editState.estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
            ? parsedEstimatedMinutes
            : 0,
      });

      setTasks((current) => current.map((item) => (item._id === taskId ? response.task : item)));
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
