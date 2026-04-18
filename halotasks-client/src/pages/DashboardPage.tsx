import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import { taskService } from '../services/taskService';
import { Priority, Task } from '../types/task';

type FilterMode = 'all' | 'active' | 'completed';

type TaskEditState = {
  title: string;
  priority: Priority;
  tags: string[];
  tagInput: string;
  dueDate: string;
  estimatedMinutes: string;
};

const SUGGESTED_TAGS = ['work', 'study', 'health', 'personal', 'urgent', 'finance'] as const;
const MAX_TAGS = 5;
const MAX_TAG_LENGTH = 20;

const toTitleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

const normalizeTag = (value: string) => value.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);

const sanitizeTags = (tags: string[]) => {
  const unique = new Set<string>();

  for (const tag of tags) {
    const normalized = normalizeTag(tag);

    if (!normalized) {
      continue;
    }

    unique.add(normalized);

    if (unique.size >= MAX_TAGS) {
      break;
    }
  }

  return Array.from(unique);
};

const tryAddTag = (currentTags: string[], rawValue: string) => {
  const normalized = normalizeTag(rawValue);

  if (!normalized) {
    return {
      tags: currentTags,
      message: null as string | null,
    };
  }

  if (currentTags.includes(normalized)) {
    return {
      tags: currentTags,
      message: null as string | null,
    };
  }

  if (currentTags.length >= MAX_TAGS) {
    return {
      tags: currentTags,
      message: `Maximum ${MAX_TAGS} tags allowed per task.`,
    };
  }

  return {
    tags: [...currentTags, normalized],
    message: null as string | null,
  };
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

      if (tagFilter) {
        const hasTag = task.tags.some((tag) => normalizeTag(tag) === tagFilter);
        if (!hasTag) {
          return false;
        }
      }

      if (!normalizedSearch) {
        return true;
      }

      return (
        task.title.toLowerCase().includes(normalizedSearch) ||
        task.description.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [tasks, filterMode, priorityFilter, search, tagFilter]);

  const commitCreateTag = (rawTag: string) => {
    const result = tryAddTag(createTags, rawTag);
    setCreateTags(result.tags);

    if (result.message) {
      setStatusError(result.message);
    }

    return result;
  };

  const commitEditTag = (rawTag: string) => {
    if (!editState) {
      return;
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
  };

  const handleCreateTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== ',') {
      return;
    }

    event.preventDefault();
    const result = commitCreateTag(createTagInput);
    if (!result.message) {
      setCreateTagInput('');
    }
  };

  const handleEditTagInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' && event.key !== ',') {
      return;
    }

    event.preventDefault();
    commitEditTag(editState?.tagInput ?? '');
  };

  const toggleCreateSuggestedTag = (tag: string) => {
    setStatusError(null);

    if (createTags.includes(tag)) {
      setCreateTags((current) => current.filter((item) => item !== tag));
      return;
    }

    const result = tryAddTag(createTags, tag);
    setCreateTags(result.tags);
    if (result.message) {
      setStatusError(result.message);
    }
  };

  const toggleEditSuggestedTag = (tag: string) => {
    if (!editState) {
      return;
    }

    setStatusError(null);

    if (editState.tags.includes(tag)) {
      setEditState((current) =>
        current
          ? {
              ...current,
              tags: current.tags.filter((item) => item !== tag),
            }
          : current,
      );
      return;
    }

    const result = tryAddTag(editState.tags, tag);
    setEditState((current) =>
      current
        ? {
            ...current,
            tags: result.tags,
          }
        : current,
    );

    if (result.message) {
      setStatusError(result.message);
    }
  };

  const removeCreateTag = (tag: string) => {
    setCreateTags((current) => current.filter((item) => item !== tag));
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

  const toggleTagFilter = (tag: string) => {
    const normalized = normalizeTag(tag);
    setTagFilter((current) => (current === normalized ? null : normalized));
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

  const startEditingTask = (task: Task) => {
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
          <div className="tag-input-block">
            <div className="chip-row">
              {SUGGESTED_TAGS.map((tag) => (
                <button
                  key={`create-suggested-${tag}`}
                  type="button"
                  className={createTags.includes(tag) ? 'tag-chip selected' : 'tag-chip'}
                  onClick={() => toggleCreateSuggestedTag(tag)}
                >
                  {toTitleCase(tag)}
                </button>
              ))}
            </div>

            <div className="chip-row selected-row">
              {createTags.map((tag) => (
                <span key={`create-selected-${tag}`} className="selected-chip">
                  {tag}
                  <button type="button" onClick={() => removeCreateTag(tag)} aria-label={`Remove ${tag}`}>
                    x
                  </button>
                </span>
              ))}
            </div>

            <input
              type="text"
              value={createTagInput}
              onChange={(event) => setCreateTagInput(event.target.value)}
              onKeyDown={handleCreateTagInputKeyDown}
              onBlur={() => {
                const result = commitCreateTag(createTagInput);
                if (!result.message) {
                  setCreateTagInput('');
                }
              }}
              placeholder="Type tag then Enter or comma"
            />
          </div>
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

        {tagFilter && (
          <div className="active-filter-row">
            <span className="active-filter-chip">Filtering by tag: {tagFilter}</span>
            <button type="button" className="ghost-btn" onClick={() => setTagFilter(null)}>
              Clear
            </button>
          </div>
        )}

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
                    <div className="tag-input-block">
                      <div className="chip-row">
                        {SUGGESTED_TAGS.map((tag) => (
                          <button
                            key={`edit-suggested-${task._id}-${tag}`}
                            type="button"
                            className={editState.tags.includes(tag) ? 'tag-chip selected' : 'tag-chip'}
                            onClick={() => toggleEditSuggestedTag(tag)}
                          >
                            {toTitleCase(tag)}
                          </button>
                        ))}
                      </div>

                      <div className="chip-row selected-row">
                        {editState.tags.map((tag) => (
                          <span key={`edit-selected-${task._id}-${tag}`} className="selected-chip">
                            {tag}
                            <button type="button" onClick={() => removeEditTag(tag)} aria-label={`Remove ${tag}`}>
                              x
                            </button>
                          </span>
                        ))}
                      </div>

                      <input
                        type="text"
                        value={editState.tagInput}
                        onChange={(event) =>
                          setEditState((current) =>
                            current
                              ? {
                                  ...current,
                                  tagInput: event.target.value,
                                }
                              : current,
                          )
                        }
                        onKeyDown={handleEditTagInputKeyDown}
                        onBlur={() => commitEditTag(editState.tagInput)}
                        placeholder="Type tag then Enter or comma"
                      />
                    </div>
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
                        {task.tags.length > 0 && (
                          <span className="task-tag-row">
                            {task.tags.map((tag) => {
                              const normalizedTag = normalizeTag(tag);

                              return (
                                <button
                                  key={`${task._id}-tag-${normalizedTag}`}
                                  type="button"
                                  className={
                                    tagFilter === normalizedTag
                                      ? 'tag-chip active-filter'
                                      : 'tag-chip task-tag-chip'
                                  }
                                  onClick={() => toggleTagFilter(normalizedTag)}
                                >
                                  {normalizedTag}
                                </button>
                              );
                            })}
                          </span>
                        )}
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