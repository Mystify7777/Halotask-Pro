import { FormEvent, useEffect, useState } from 'react';
import { AxiosError } from 'axios';
import TaskCreateForm from '../components/dashboard/TaskCreateForm';
import TaskFilters from '../components/dashboard/TaskFilters';
import TaskList from '../components/dashboard/TaskList';
import { TaskEditState } from '../components/dashboard/types';
import { useTaskFilters, FilterMode } from '../hooks/useTaskFilters';
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
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<string | null>(null);

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editState, setEditState] = useState<TaskEditState | null>(null);

  const createTagSuggestions = useTagSuggestions(tasks, createTagInput, createTags);
  const editTagSuggestions = useTagSuggestions(tasks, editState?.tagInput ?? '', editState?.tags ?? []);

  const filteredTasks = useTaskFilters({
    tasks,
    search,
    filterMode,
    priorityFilter,
    tagFilter,
  });

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
          tagFilter={tagFilter}
          onSearchChange={setSearch}
          onFilterModeChange={setFilterMode}
          onPriorityFilterChange={setPriorityFilter}
          onClearTagFilter={() => setTagFilter(null)}
        />

        {statusError && <p className="form-error">{statusError}</p>}
        {statusInfo && <p className="form-success">{statusInfo}</p>}

        <TaskList
          tasks={filteredTasks}
          loadingTasks={loadingTasks}
          activeActionTaskId={activeActionTaskId}
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
          onToggleTagFilter={(tag) => setTagFilter((current) => (current === tag ? null : tag))}
          onAddEditTag={addEditTag}
          onRemoveEditTag={removeEditTag}
        />
      </div>
    </section>
  );
}
