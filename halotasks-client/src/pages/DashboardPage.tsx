import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import { taskService } from '../services/taskService';
import { Priority, Task } from '../types/task';

type FilterMode = 'all' | 'active' | 'completed';

type TaskEditState = {
  title: string;
  priority: Priority;
  tagsText: string;
  dueDate: string;
  estimatedMinutes: string;
};

const formatDateForInput = (value?: string) => {
  if (!value) {
    return '';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return date.toISOString().split('T')[0];
};

const getDateBadgeClass = (value?: string) => {
  if (!value) {
    return 'date-muted';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'date-muted';
  }

  const due = new Date(date.toDateString()).getTime();
  const today = new Date(new Date().toDateString()).getTime();

  if (due < today) {
    return 'date-overdue';
  }

  if (due === today) {
    return 'date-today';
  }

  return 'date-muted';
};

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loadingTasks, setLoadingTasks] = useState(true);
  const [creatingTask, setCreatingTask] = useState(false);
  const [activeActionTaskId, setActiveActionTaskId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueDate, setDueDate] = useState('');
  const [tagsText, setTagsText] = useState('');
  const [estimatedMinutes, setEstimatedMinutes] = useState('');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all');
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusInfo, setStatusInfo] = useState<string | null>(null);
  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editState, setEditState] = useState<TaskEditState | null>(null);

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

  const filteredTasks = useMemo(() => {
    const normalizedSearch = search.trim().toLowerCase();

    return tasks.filter((task) => {
      if (filterMode === 'active' && task.completed) {
        return false;
      }

      if (filterMode === 'completed' && !task.completed) {
        return false;
      }

      if (priorityFilter !== 'all' && task.priority !== priorityFilter) {
        return false;
      }

      if (!normalizedSearch) {
        return true;
      }

      return (
        task.title.toLowerCase().includes(normalizedSearch) ||
        task.description.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [tasks, filterMode, priorityFilter, search]);

  const handleCreateTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatusError(null);
    setStatusInfo(null);

    if (!title.trim()) {
      return;
    }

    try {
      setCreatingTask(true);

      const parsedTags = tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      const parsedEstimatedMinutes = Number(estimatedMinutes);

      const response = await taskService.createTask({
        title: title.trim(),
        priority,
        tags: parsedTags,
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
      setTagsText('');
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

  const startEditingTask = (task: Task) => {
    setEditingTaskId(task._id);
    setEditState({
      title: task.title,
      priority: task.priority,
      tagsText: task.tags.join(', '),
      dueDate: formatDateForInput(task.dueDate),
      estimatedMinutes: task.estimatedMinutes > 0 ? String(task.estimatedMinutes) : '',
    });
  };

  const cancelEditingTask = () => {
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

      const parsedTags = editState.tagsText
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

      const parsedEstimatedMinutes = Number(editState.estimatedMinutes);

      const response = await taskService.updateTask(taskId, {
        title: editState.title.trim(),
        priority: editState.priority,
        tags: parsedTags,
        dueDate: editState.dueDate || null,
        estimatedMinutes:
          editState.estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
            ? parsedEstimatedMinutes
            : 0,
      });

      setTasks((current) => current.map((item) => (item._id === taskId ? response.task : item)));
      cancelEditingTask();
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
        <form className="task-create-form" onSubmit={handleCreateTask}>
          <input
            type="text"
            placeholder="Add a task title"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
          <select value={priority} onChange={(event) => setPriority(event.target.value as Priority)}>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
          <input
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.target.value)}
            aria-label="Due date"
          />
          <input
            type="text"
            value={tagsText}
            onChange={(event) => setTagsText(event.target.value)}
            placeholder="Tags: study, work"
          />
          <input
            type="number"
            min={0}
            value={estimatedMinutes}
            onChange={(event) => setEstimatedMinutes(event.target.value)}
            placeholder="Estimated minutes"
          />
          <button type="submit" disabled={creatingTask}>
            {creatingTask ? 'Saving...' : 'Add Task'}
          </button>
        </form>
      </div>

      <div className="panel">
        <div className="filter-row">
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tasks"
          />
          <select value={filterMode} onChange={(event) => setFilterMode(event.target.value as FilterMode)}>
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="completed">Completed</option>
          </select>
          <select
            value={priorityFilter}
            onChange={(event) => setPriorityFilter(event.target.value as 'all' | Priority)}
          >
            <option value="all">All Priorities</option>
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>

        {statusError && <p className="form-error">{statusError}</p>}
        {statusInfo && <p className="form-success">{statusInfo}</p>}

        {loadingTasks ? (
          <p>Loading tasks...</p>
        ) : filteredTasks.length === 0 ? (
          <p>No tasks match the current filters.</p>
        ) : (
          <ul className="task-list">
            {filteredTasks.map((task) => (
              <li key={task._id} className={task.completed ? 'task-item complete' : 'task-item'}>
                {editingTaskId === task._id && editState ? (
                  <div className="edit-panel">
                    <input
                      type="text"
                      value={editState.title}
                      onChange={(event) =>
                        setEditState((current) =>
                          current
                            ? {
                                ...current,
                                title: event.target.value,
                              }
                            : current,
                        )
                      }
                    />
                    <select
                      value={editState.priority}
                      onChange={(event) =>
                        setEditState((current) =>
                          current
                            ? {
                                ...current,
                                priority: event.target.value as Priority,
                              }
                            : current,
                        )
                      }
                    >
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                    </select>
                    <input
                      type="date"
                      value={editState.dueDate}
                      onChange={(event) =>
                        setEditState((current) =>
                          current
                            ? {
                                ...current,
                                dueDate: event.target.value,
                              }
                            : current,
                        )
                      }
                    />
                    <input
                      type="text"
                      value={editState.tagsText}
                      onChange={(event) =>
                        setEditState((current) =>
                          current
                            ? {
                                ...current,
                                tagsText: event.target.value,
                              }
                            : current,
                        )
                      }
                      placeholder="study, work, urgent"
                    />
                    <input
                      type="number"
                      min={0}
                      value={editState.estimatedMinutes}
                      onChange={(event) =>
                        setEditState((current) =>
                          current
                            ? {
                                ...current,
                                estimatedMinutes: event.target.value,
                              }
                            : current,
                        )
                      }
                      placeholder="Estimated minutes"
                    />
                    <div className="task-actions">
                      <button
                        onClick={() => handleSaveTaskEdit(task._id)}
                        disabled={activeActionTaskId === task._id}
                      >
                        {activeActionTaskId === task._id ? 'Saving...' : 'Save'}
                      </button>
                      <button className="ghost-btn" onClick={cancelEditingTask} type="button">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={task.completed}
                        onChange={() => handleToggleTask(task)}
                        disabled={activeActionTaskId === task._id}
                      />
                      <span>
                        <strong>{task.title}</strong>
                        <small>Priority: {task.priority}</small>
                        <small className={getDateBadgeClass(task.dueDate)}>
                          {task.dueDate ? `Due: ${formatDateForInput(task.dueDate)}` : 'No due date'}
                        </small>
                        {task.tags.length > 0 && <small>Tags: {task.tags.join(', ')}</small>}
                        {task.estimatedMinutes > 0 && <small>Est: {task.estimatedMinutes} min</small>}
                      </span>
                    </label>
                    <div className="task-actions">
                      <button className="ghost-btn" onClick={() => startEditingTask(task)} type="button">
                        Edit
                      </button>
                      <button
                        className="danger-btn"
                        onClick={() => handleDeleteTask(task._id)}
                        disabled={activeActionTaskId === task._id}
                        type="button"
                      >
                        {activeActionTaskId === task._id ? 'Deleting...' : 'Delete'}
                      </button>
                    </div>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}