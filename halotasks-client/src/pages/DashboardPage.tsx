import { FormEvent, useEffect, useMemo, useState } from 'react';
import { AxiosError } from 'axios';
import { taskService } from '../services/taskService';
import { Priority, Task } from '../types/task';

type FilterMode = 'all' | 'active' | 'completed';

export default function DashboardPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all');
  const [error, setError] = useState<string | null>(null);

  const loadTasks = async () => {
    try {
      setLoading(true);
      const response = await taskService.getTasks();
      setTasks(response.tasks);
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Unable to load tasks');
    } finally {
      setLoading(false);
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

    if (!title.trim()) {
      return;
    }

    try {
      setSaving(true);
      const response = await taskService.createTask({
        title,
        priority,
      });

      setTasks((current) => [response.task, ...current]);
      setTitle('');
      setPriority('medium');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Unable to create task');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleTask = async (task: Task) => {
    try {
      const response = await taskService.updateTask(task._id, { completed: !task.completed });
      setTasks((current) => current.map((item) => (item._id === task._id ? response.task : item)));
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Unable to update task');
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await taskService.deleteTask(taskId);
      setTasks((current) => current.filter((task) => task._id !== taskId));
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setError(axiosError.response?.data?.message ?? 'Unable to delete task');
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
          <button type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Add Task'}
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

        {error && <p className="form-error">{error}</p>}

        {loading ? (
          <p>Loading tasks...</p>
        ) : filteredTasks.length === 0 ? (
          <p>No tasks match the current filters.</p>
        ) : (
          <ul className="task-list">
            {filteredTasks.map((task) => (
              <li key={task._id} className={task.completed ? 'task-item complete' : 'task-item'}>
                <label>
                  <input type="checkbox" checked={task.completed} onChange={() => handleToggleTask(task)} />
                  <span>
                    <strong>{task.title}</strong>
                    <small>Priority: {task.priority}</small>
                  </span>
                </label>
                <button className="danger-btn" onClick={() => handleDeleteTask(task._id)}>
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}