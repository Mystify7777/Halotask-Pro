import { FormEvent, RefObject, useEffect, useRef, useState } from 'react';
import { useTaskFilters, FilterMode } from './useTaskFilters';
import { useTaskSelection } from './useTaskSelection';
import { TaskSortOption, useTaskSorting } from './useTaskSorting';
import { useTagSuggestions } from './useTagSuggestions';
import { makeCompletionTransition, type CompletionTransition } from '../offline/completionEvents';
import type { QueueActionInput } from '../offline/queueActions';
import { commitLocalMutation, type CommitResult, type LocalMutation } from '../offline/localMutations';
import {
  assertNewLocalId,
  MutationRejectedError,
  newLocalTaskId,
  requireTask,
  validateTaskFields,
} from '../offline/mutationValidation';
import { Priority, Subtask, Task, TaskCreatePayload, TaskUpdatePayload } from '../types/task';
import type { GrowthResult } from '../growth/treeTypes';
import { formatDateForInput } from '../utils/dateHelpers';
import { dueDayKey, formatDayKey, isoToStartInput, isValidDueTime, startInputToIso } from '../utils/deadline';
import { dateKeyInZone } from '../utils/timeZone';
import { sanitizeTags, tryAddTag } from '../utils/tagHelpers';
import { getSubtasks, prepareSubtasks, sameSubtasks, subtaskCopyLines, withSubtaskCompleted } from '../utils/subtasks';
import { updateCachedTasks } from '../offline/cache';
import { updateTodaySnapshot } from '../offline/history';
import type { TaskEditState } from '../components/dashboard/types';

type AddTagResult = {
  message: string | null;
};

/** Today's date as YYYY-MM-DD in the user's effective time zone (Issue #41): neither UTC nor the device's zone. */
const getTodayDateString = (): string => dateKeyInZone(Date.now());

type SyncBridge = {
  refreshPendingQueueCount: () => Promise<number>;
  /** Starts sending what was just committed locally. A no-op while offline; never runs two drains at once. */
  requestSync: () => void;
};

const STORAGE_ERROR = 'Could not save the change on this device — storage unavailable. Please try again.';

type UseDashboardTasksArgs = {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  isOnline: boolean;
  syncBridgeRef: RefObject<SyncBridge>;
  /** Offline only: show +10 immediately; never persisted (the server awards on sync). */
  previewGrowthForCompletion: (taskId: string) => void;
  /** Adopt the tree the server returned with a completion. Reached through the sync drain now, not from here. */
  applyServerGrowth?: (growth: GrowthResult | undefined) => void;
  setStatusError: (message: string | null) => void;
  setStatusInfo: (message: string | null) => void;
};

export function useDashboardTasks({
  tasks,
  setTasks,
  isOnline,
  syncBridgeRef,
  previewGrowthForCompletion,
  setStatusError,
  setStatusInfo,
}: UseDashboardTasksArgs) {
  const [creatingTask, setCreatingTask] = useState(false);
  const [bulkActionLoading, setBulkActionLoading] = useState(false);
  const [activeActionTaskId, setActiveActionTaskId] = useState<string | null>(null);

  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState<Priority>('medium');
  const [dueDate, setDueDate] = useState(getTodayDateString);
  const [dueTime, setDueTime] = useState('');
  const [startTime, setStartTime] = useState('');
  const [createTags, setCreateTags] = useState<string[]>(['personal']);
  const [createTagInput, setCreateTagInput] = useState('');
  const [estimatedMinutes, setEstimatedMinutes] = useState('30');
  const [description, setDescription] = useState('');
  const [createSubtasks, setCreateSubtasksState] = useState<Subtask[]>([]);
  const [createSubtasksError, setCreateSubtasksError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [filterMode, setFilterMode] = useState<FilterMode>('active');
  const [priorityFilter, setPriorityFilter] = useState<'all' | Priority>('all');
  const [sortBy, setSortBy] = useState<TaskSortOption>('dueSoonest');
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  const [, setBulkFailedTaskIds] = useState<string[]>([]);

  const [editingTaskId, setEditingTaskId] = useState<string | null>(null);
  const [editState, setEditState] = useState<TaskEditState | null>(null);
  const latestTasksRef = useRef(tasks);
  /** A deep, private copy of the description and checklist as the edit sheet OPENED: the baseline for "did the user change it?". */
  const editSnapshotRef = useRef<{ description: string; subtasks: Subtask[] } | null>(null);
  useEffect(() => {
    latestTasksRef.current = tasks;
  }, [tasks]);

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

  /**
   * Replaces the task list from a caller that is NOT a user mutation (the sync run adopting a server answer, AI-created
   * tasks). The update runs on the STORED list inside one transaction, serialized with every local commit, so it can never
   * put back a list that a committed mutation has already replaced (Issue #57). State follows what was stored.
   */
  const persistTasks = (updater: (current: Task[]) => Task[], skipSnapshot = false) => {
    void updateCachedTasks(updater, latestTasksRef.current)
      .then((next) => {
        latestTasksRef.current = next;
        setTasks(next);
        if (!skipSnapshot) void updateTodaySnapshot(next); // keep 7-day history in sync
      })
      .catch(() => {
        // Storage is unavailable: still show the change; the next load shows what was really stored.
        setTasks((current) => updater(current));
      });
  };

  /** Shows a list the sync run has just stored (Issue #61): state, the ref the next commit seeds from, and the 7-day snapshot. */
  const showStoredTasks = (next: Task[]) => {
    latestTasksRef.current = next;
    setTasks(next);
    void updateTodaySnapshot(next);
  };

  /**
   * THE way a user's task mutation happens (Issue #57): validate and derive inside one IndexedDB transaction that also
   * writes the queue entries, wait for that commit, and only then render. If it throws, nothing was stored and nothing is
   * shown. Online, the queue is then drained in the background; offline the entries wait.
   */
  const commitMutation = async (mutation: LocalMutation, options: { skipSnapshot?: boolean } = {}): Promise<CommitResult> => {
    const result = await commitLocalMutation({ seed: latestTasksRef.current, ...mutation });
    latestTasksRef.current = result.tasks;
    setTasks(result.tasks);
    if (!options.skipSnapshot) void updateTodaySnapshot(result.tasks);
    try {
      await syncBridgeRef.current.refreshPendingQueueCount();
    } catch {
      // the count is a display; the commit already happened
    }
    // Offline the entry simply waits: the sync state derives "offline, N stored on this device" from the queue (Issue #58).
    if (isOnline) syncBridgeRef.current.requestSync();
    return result;
  };

  const reportCommitFailure = (error: unknown) => {
    setStatusError(error instanceof MutationRejectedError ? error.message : STORAGE_ERROR);
  };

  const createLocalTask = (payload: TaskCreatePayload, id: string): Task => {
    const now = new Date().toISOString();

    return {
      _id: id,
      userId: 'local-user',
      title: payload.title,
      description: payload.description ?? '',
      completed: false,
      priority: payload.priority,
      tags: payload.tags ?? [],
      subtasks: payload.subtasks ?? [],
      dueDate: payload.dueDate,
      dueTime: payload.dueTime,
      startTime: payload.startTime,
      estimatedMinutes: payload.estimatedMinutes ?? 0,
      reminderSent: false,
      createdAt: now,
      updatedAt: now,
      pendingSync: true,
    };
  };

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

  const resetCreateExtras = () => {
    setDescription('');
    setCreateSubtasksState([]);
    setCreateSubtasksError(null);
  };

  const handleCreateTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setStatusError(null);
    setStatusInfo(null);

    if (!title.trim()) {
      return;
    }

    // Refused before anything is stored or queued; what the user typed stays in the form.
    const prepared = prepareSubtasks(createSubtasks);
    if (!prepared.ok) {
      setCreateSubtasksError(prepared.message);
      return;
    }
    setCreateSubtasksError(null);

    const parsedEstimatedMinutes = Number(estimatedMinutes);
    const payload: TaskCreatePayload = {
      title: title.trim(),
      // Optional fields stay optional: sent only when the user filled them in.
      description: description.trim() || undefined,
      subtasks: prepared.subtasks.length > 0 ? prepared.subtasks : undefined,
      priority,
      tags: sanitizeTags(createTags),
      dueDate: dueDate || undefined,
      // A due time only exists next to a due date; a start time is stored as the instant the user's local entry names.
      dueTime: dueDate && isValidDueTime(dueTime) ? dueTime : undefined,
      startTime: startInputToIso(startTime) ?? undefined,
      estimatedMinutes:
        estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
          ? parsedEstimatedMinutes
          : undefined,
    };

    const invalid = validateTaskFields(payload, 'create');
    if (invalid) {
      setStatusError(invalid);
      return;
    }

    try {
      setCreatingTask(true);
      const localId = newLocalTaskId();
      await commitMutation({
        derive: (stored) => {
          assertNewLocalId(stored, localId);
          return {
            tasks: [createLocalTask(payload, localId), ...stored],
            actions: [{ type: 'create', taskId: localId, payload }],
          };
        },
      });

      setTitle('');
      setPriority('medium');
      setDueDate(getTodayDateString());
      setDueTime('');
      setStartTime('');
      setCreateTags(['personal']);
      setCreateTagInput('');
      setEstimatedMinutes('30');
      resetCreateExtras();
      setStatusInfo(isOnline ? 'Task created.' : 'Task saved offline. Pending sync.');
    } catch (error) {
      reportCommitFailure(error);
    } finally {
      setCreatingTask(false);
    }
  };

  /**
   * Completing or re-opening a task (Issue #47, Phase 2E). ONE completion event is created here, from the task as it is
   * STORED when the commit runs (not the object a render captured), and it is the same event whether it is sent now or
   * waits in the queue: a `completion` entry whose id never changes, so a retry, a reload or a replay cannot make a second
   * record. Two quick taps are two commits, each building on the one before.
   */
  const handleToggleTask = async (task: Task) => {
    setStatusError(null);
    setStatusInfo(null);

    const outcome: { transition?: CompletionTransition; wasCompleted?: boolean } = {};
    try {
      setActiveActionTaskId(task._id);
      await commitMutation({
        derive: (stored) => {
          const latest = requireTask(stored, task._id);
          const transition = makeCompletionTransition(latest);
          outcome.transition = transition;
          outcome.wasCompleted = latest.completed;
          const updatedAt = new Date().toISOString();
          return {
            tasks: stored.map((item) => (item._id === task._id ? { ...item, ...transition.localPatch, updatedAt, pendingSync: true } : item)),
            actions: [{ type: 'completion', taskId: task._id, payload: transition.entry }],
          };
        },
      });
    } catch (error) {
      // Nothing was recorded, so the task is left as it was: an optimistic flip with no event behind it would be a lie.
      reportCommitFailure(error);
      return;
    } finally {
      setActiveActionTaskId(null);
    }

    const earnedXp = Boolean(outcome.transition?.completed) && !outcome.wasCompleted;
    if (earnedXp) previewGrowthForCompletion(task._id);
    setStatusInfo(
      isOnline
        ? 'Task completion updated.'
        : earnedXp
          ? 'Task updated offline. Pending sync. +10 XP'
          : 'Task updated offline. Pending sync.',
    );
  };

  /**
   * Sets ONE subtask's state (Issue #15). The flip is derived from the STORED task inside the commit, so two taps in the
   * same tick build on each other, and no other subtask or field of the task is ever changed. An unknown task or subtask id
   * does nothing. The whole next list is what is queued (the queue replaces an array whole, like `tags`), and the parent
   * task's `completed` is never touched. There is no rollback to hand-build: if the commit fails nothing was stored.
   */
  const toggleSubtask = async (taskId: string, subtaskId: string) => {
    if (!latestTasksRef.current.some((item) => item._id === taskId)) return;

    setStatusError(null);
    setStatusInfo(null);

    let changed = false;
    try {
      await commitMutation(
        {
          derive: (stored) => {
            const task = stored.find((item) => item._id === taskId);
            const before = task ? getSubtasks(task) : [];
            const target = before.find((subtask) => subtask.id === subtaskId);
            const next = target ? withSubtaskCompleted(before, subtaskId, !target.completed) : null;
            if (!task || !next) return { tasks: stored, actions: [] };
            changed = true;
            const updatedAt = new Date().toISOString();
            return {
              tasks: stored.map((item) => (item._id === taskId ? { ...item, subtasks: next, updatedAt, pendingSync: true } : item)),
              actions: [{ type: 'update', taskId, payload: { subtasks: next } }],
            };
          },
        },
        { skipSnapshot: true },
      );
    } catch (error) {
      reportCommitFailure(error);
      return;
    }
    if (changed && !isOnline) setStatusInfo('Subtask updated offline. Pending sync.');
  };

  const handleDeleteTask = async (taskId: string) => {
    setStatusError(null);
    setStatusInfo(null);

    let deleted = false;
    try {
      setActiveActionTaskId(taskId);
      await commitMutation({
        derive: (stored) => {
          // Deleting a task that is already gone changes nothing (and queues nothing).
          if (!stored.some((item) => item._id === taskId)) return { tasks: stored, actions: [] };
          deleted = true;
          return { tasks: stored.filter((item) => item._id !== taskId), actions: [{ type: 'delete', taskId }] };
        },
      });
    } catch (error) {
      reportCommitFailure(error);
      return;
    } finally {
      setActiveActionTaskId(null);
    }
    if (deleted) setStatusInfo(isOnline ? 'Task deleted.' : 'Task deleted offline. Pending sync.');
  };

  const handleClearCompleted = async () => {
    setStatusError(null);
    setStatusInfo(null);
    setBulkFailedTaskIds([]);

    const currentTasks = latestTasksRef.current;
    if (!currentTasks.some((task) => task.completed)) {
      setStatusInfo('No completed tasks to clear.');
      return;
    }

    // Snapshot BEFORE deletion so "Completed Today" count survives clear.
    await updateTodaySnapshot(currentTasks);

    let clearedCount = 0;
    try {
      setBulkActionLoading(true);
      await commitMutation(
        {
          // The completed tasks are chosen from the STORED list, so one completed a moment ago is included.
          derive: (stored) => {
            const ids = stored.filter((task) => task.completed).map((task) => task._id);
            clearedCount = ids.length;
            return {
              tasks: stored.filter((task) => !ids.includes(task._id)),
              actions: ids.map((taskId) => ({ type: 'delete' as const, taskId })),
            };
          },
        },
        { skipSnapshot: true },
      );
    } catch (error) {
      reportCommitFailure(error);
      return;
    } finally {
      setBulkActionLoading(false);
    }

    clearSelection();
    if (clearedCount === 0) {
      setStatusInfo('No completed tasks to clear.');
      return;
    }
    setStatusInfo(`Cleared ${clearedCount} completed task${clearedCount === 1 ? '' : 's'}${isOnline ? '' : ' offline'}.`);
  };

  const handleMarkSelectedComplete = async () => {
    setStatusError(null);
    setStatusInfo(null);
    setBulkFailedTaskIds([]);

    if (selectedVisibleIds.length === 0) {
      return;
    }

    const selectedIdSet = new Set(selectedVisibleIds);
    if (!sortedTasks.some((task) => selectedIdSet.has(task._id) && !task.completed)) {
      setStatusInfo('Selected tasks are already completed.');
      return;
    }

    // One completion event per task, from the stored state of each (a task completed meanwhile is skipped, never completed twice).
    const completedIds: string[] = [];
    try {
      setBulkActionLoading(true);
      await commitMutation({
        derive: (stored) => {
          const updatedAt = new Date().toISOString();
          const actions: QueueActionInput[] = [];
          completedIds.length = 0;
          const tasks = stored.map((item) => {
            if (!selectedIdSet.has(item._id) || item.completed) return item;
            const transition = makeCompletionTransition(item);
            completedIds.push(item._id);
            actions.push({ type: 'completion', taskId: item._id, payload: transition.entry });
            return { ...item, ...transition.localPatch, updatedAt, pendingSync: true };
          });
          return { tasks, actions };
        },
      });
    } catch (error) {
      reportCommitFailure(error);
      return;
    } finally {
      setBulkActionLoading(false);
    }

    completedIds.forEach((taskId) => previewGrowthForCompletion(taskId));
    clearSelection();
    if (completedIds.length === 0) {
      setStatusInfo('Selected tasks are already completed.');
      return;
    }
    const count = completedIds.length;
    setStatusInfo(
      isOnline
        ? `Marked ${count} task${count === 1 ? '' : 's'} complete.`
        : `Marked ${count} task${count === 1 ? '' : 's'} complete offline. +${count * 10} XP`,
    );
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

    const ids = [...selectedVisibleIds];
    let deletedCount = 0;
    try {
      setBulkActionLoading(true);
      await commitMutation({
        derive: (stored) => {
          const present = ids.filter((id) => stored.some((task) => task._id === id));
          deletedCount = present.length;
          return {
            tasks: stored.filter((task) => !present.includes(task._id)),
            actions: present.map((taskId) => ({ type: 'delete' as const, taskId })),
          };
        },
      });
    } catch (error) {
      reportCommitFailure(error);
      return;
    } finally {
      setBulkActionLoading(false);
    }

    clearSelection();
    setStatusInfo(`Deleted ${deletedCount} task${deletedCount === 1 ? '' : 's'}${isOnline ? '' : ' offline'}.`);
  };

  const handleCopySelected = async () => {
    setStatusError(null);
    setStatusInfo(null);

    if (selectedVisibleIds.length === 0) {
      setStatusInfo('No tasks selected to copy.');
      return;
    }

    const selectedTasks = sortedTasks.filter((task) => selectedVisibleIds.includes(task._id));

    const lines = selectedTasks
      .map((t) => {
        const priorityLabel = t.priority;
        const title = t.title;
        const dueDay = dueDayKey(t.dueDate);
        const due = dueDay ? `due: ${formatDayKey(dueDay)}` : null;
        const minutes = t.estimatedMinutes ? `~${t.estimatedMinutes}m` : null;
        const tags = (t.tags ?? []).map((tag) => `#${tag}`).join(' ');

        const parts: string[] = [];
        parts.push(`• [${priorityLabel}] ${title}`);

        const meta: string[] = [];
        if (due) meta.push(due);
        if (minutes) meta.push(minutes);

        if (meta.length > 0) parts.push(`(${meta.join(', ')})`);
        if (tags) parts.push(tags);

        const firstLine = parts.join(' ');
        const description = t.description?.trim();
        return [firstLine, ...(description ? [description] : []), ...subtaskCopyLines(t)].join('\n');
      })
      .join('\n');

    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(lines);
        setStatusInfo(`Copied ${selectedTasks.length} task${selectedTasks.length === 1 ? '' : 's'}`);
      } else {
        setStatusError('Clipboard API not available in this environment.');
      }
    } catch (err) {
      setStatusError('Unable to copy to clipboard. Please allow clipboard permissions.');
    }
  };

  const handleStartEditing = (task: Task) => {
    setEditingTaskId(task._id);
    // Separate copies: the form's list and the baseline never share an object, so editing cannot move the baseline.
    editSnapshotRef.current = {
      description: task.description ?? '',
      subtasks: getSubtasks(task).map((subtask) => ({ ...subtask })),
    };
    setEditState({
      description: task.description ?? '',
      subtasks: getSubtasks(task).map((subtask) => ({ ...subtask })),
      saveError: null,
      title: task.title,
      priority: task.priority,
      tags: sanitizeTags(task.tags),
      tagInput: '',
      dueDate: formatDateForInput(task.dueDate),
      dueTime: task.dueDate && isValidDueTime(task.dueTime) ? task.dueTime : '',
      startTime: isoToStartInput(task.startTime),
      estimatedMinutes: task.estimatedMinutes > 0 ? String(task.estimatedMinutes) : '',
    });
  };

  const handleCancelEditing = () => {
    editSnapshotRef.current = null;
    setEditingTaskId(null);
    setEditState(null);
  };

  const handleSaveTaskEdit = async (taskId: string) => {
    if (!editState || !editState.title.trim()) {
      return;
    }

    const snapshot = editSnapshotRef.current;
    let subtasksToSend: Subtask[] | undefined;
    if (snapshot && editState.subtasks !== undefined) {
      const prepared = prepareSubtasks(editState.subtasks);
      if (!prepared.ok) {
        // No request, no queue write, no optimistic change; the form keeps everything the user typed.
        setEditState((current) => (current ? { ...current, saveError: prepared.message } : current));
        return;
      }
      // Sent ONLY when the user changed it (ids, titles, states, order). An unchanged list is omitted so this save can
      // never overwrite a checkbox toggled elsewhere while the sheet was open.
      if (!sameSubtasks(prepared.subtasks, snapshot.subtasks)) {
        // The editor cannot change completion, so a toggle made since the sheet opened is the truth: keep it.
        const latest = getSubtasks(latestTasksRef.current.find((item) => item._id === taskId) ?? {});
        const latestState = new Map(latest.map((subtask) => [subtask.id, subtask.completed]));
        subtasksToSend = prepared.subtasks.map((subtask) => ({ ...subtask, completed: latestState.get(subtask.id) ?? subtask.completed }));
      }
    }
    const descriptionToSend =
      snapshot && editState.description !== undefined && editState.description !== snapshot.description
        ? editState.description.trim()
        : undefined;

    setStatusError(null);
    setStatusInfo(null);

    const parsedEstimatedMinutes = Number(editState.estimatedMinutes);
    // The start input only holds minutes. If the user did not change it, send the stored instant back untouched
    // rather than a re-rounded copy, so saving an unrelated edit can never alter (or erase) a start time.
    const existingStart = latestTasksRef.current.find((item) => item._id === taskId)?.startTime;
    const startTimeValue =
      editState.startTime === isoToStartInput(existingStart) && existingStart
        ? existingStart
        : startInputToIso(editState.startTime);
    const payload: TaskUpdatePayload = {
      title: editState.title.trim(),
      priority: editState.priority,
      tags: sanitizeTags(editState.tags),
      dueDate: editState.dueDate || null,
      // Always sent, `null` meaning "clear": the server never keeps a due time without a due date.
      dueTime: editState.dueDate && isValidDueTime(editState.dueTime) ? editState.dueTime : null,
      startTime: startTimeValue,
      estimatedMinutes:
        editState.estimatedMinutes && Number.isFinite(parsedEstimatedMinutes) && parsedEstimatedMinutes >= 0
          ? parsedEstimatedMinutes
          : 0,
      ...(descriptionToSend !== undefined ? { description: descriptionToSend } : {}),
      ...(subtasksToSend !== undefined ? { subtasks: subtasksToSend } : {}),
    };

    const invalid = validateTaskFields(payload, 'update');
    if (invalid) {
      setEditState((current) => (current ? { ...current, saveError: invalid } : current));
      return;
    }

    try {
      setActiveActionTaskId(taskId);
      await commitMutation({
        derive: (stored) => {
          requireTask(stored, taskId);
          const updatedAt = new Date().toISOString();
          return {
            tasks: stored.map((item) =>
              item._id === taskId
                ? {
                    ...item,
                    title: payload.title ?? item.title,
                    priority: payload.priority ?? item.priority,
                    tags: payload.tags ?? item.tags,
                    dueDate: payload.dueDate ?? undefined,
                    dueTime: payload.dueTime ?? undefined,
                    startTime: payload.startTime ?? undefined,
                    estimatedMinutes: payload.estimatedMinutes ?? item.estimatedMinutes,
                    ...(payload.description !== undefined ? { description: payload.description } : {}),
                    ...(payload.subtasks !== undefined ? { subtasks: payload.subtasks } : {}),
                    updatedAt,
                    pendingSync: true,
                  }
                : item,
            ),
            actions: [{ type: 'update', taskId, payload }],
          };
        },
      });

      handleCancelEditing();
      setStatusInfo(isOnline ? 'Task updated.' : 'Task edit saved offline. Pending sync.');
    } catch (error) {
      reportCommitFailure(error);
    } finally {
      setActiveActionTaskId(null);
    }
  };

  return {
    tasks,
    setTasks,
    persistTasks,
    showStoredTasks,

    creatingTask,
    bulkActionLoading,
    activeActionTaskId,

    title,
    setTitle,
    priority,
    setPriority,
    dueDate,
    // A due time only exists next to a due date, so clearing the date clears the time too.
    setDueDate: (value: string) => {
      setDueDate(value);
      if (!value) setDueTime('');
    },
    dueTime,
    setDueTime,
    startTime,
    setStartTime,
    createTags,
    createTagInput,
    setCreateTagInput,
    estimatedMinutes,
    setEstimatedMinutes,
    description,
    setDescription,
    createSubtasks,
    setCreateSubtasks: (next: Subtask[]) => {
      setCreateSubtasksState(next);
      setCreateSubtasksError(null);
    },
    createSubtasksError,

    search,
    setSearch,
    filterMode,
    setFilterMode,
    priorityFilter,
    setPriorityFilter,
    sortBy,
    setSortBy,
    tagFilter,
    setTagFilter,

    createTagSuggestions,
    editTagSuggestions,

    selectedVisibleIds,
    allVisibleSelected,
    visibleTaskIds,
    sortedTasks,

    editingTaskId,
    editState,
    setEditState,

    toggleSelect,
    clearSelection,
    selectAll,

    addCreateTag,
    removeCreateTag,
    addEditTag,
    removeEditTag,

    handleCreateTask,
    handleToggleTask,
    toggleSubtask,
    handleDeleteTask,
    handleClearCompleted,
    handleMarkSelectedComplete,
    handleCopySelected,
    handleDeleteSelected,
    handleStartEditing,
    handleCancelEditing,
    handleSaveTaskEdit,
  };
}
