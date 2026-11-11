import { FormEvent, RefObject, useEffect, useRef, useState } from 'react';
import { AxiosError } from 'axios';
import { useTaskFilters, FilterMode } from './useTaskFilters';
import { useTaskSelection } from './useTaskSelection';
import { TaskSortOption, useTaskSorting } from './useTaskSorting';
import { useTagSuggestions } from './useTagSuggestions';
import { enqueueSyncAction } from '../offline/syncQueue';
import { enqueueCompletion, makeCompletionTransition, type CompletionTransition } from '../offline/completionEvents';
import { isPermanentError } from '../offline/deliveryErrors';
import { taskService } from '../services/taskService';
import { Priority, Subtask, Task, TaskCreatePayload, TaskUpdatePayload } from '../types/task';
import type { GrowthResult } from '../growth/treeTypes';
import { formatDateForInput } from '../utils/dateHelpers';
import { dueDayKey, formatDayKey, isoToStartInput, isValidDueTime, startInputToIso } from '../utils/deadline';
import { dateKeyInZone } from '../utils/timeZone';
import { sanitizeTags, tryAddTag } from '../utils/tagHelpers';
import { getSubtasks, prepareSubtasks, sameSubtasks, subtaskCopyLines, withSubtaskCompleted } from '../utils/subtasks';
import { setCachedTasks } from '../offline/cache';
import { updateTodaySnapshot } from '../offline/history';
import type { TaskEditState } from '../components/dashboard/types';
import type { SyncStatus } from './useDashboardSync';
import { keepReminderIdentity } from '../reminders/identity';

type AddTagResult = {
  message: string | null;
};

/** Today's date as YYYY-MM-DD in the user's effective time zone (Issue #41): neither UTC nor the device's zone. */
const getTodayDateString = (): string => dateKeyInZone(Date.now());

type SyncBridge = {
  setSyncStatus: React.Dispatch<React.SetStateAction<SyncStatus>>;
  refreshPendingQueueCount: () => Promise<number>;
};

type UseDashboardTasksArgs = {
  tasks: Task[];
  setTasks: React.Dispatch<React.SetStateAction<Task[]>>;
  isOnline: boolean;
  syncBridgeRef: RefObject<SyncBridge>;
  /** Offline only: show +10 immediately; never persisted (the server awards on sync). */
  previewGrowthForCompletion: (taskId: string) => void;
  /** Adopt the tree the server returned with a completion. */
  applyServerGrowth: (growth: GrowthResult | undefined) => void;
  setStatusError: (message: string | null) => void;
  setStatusInfo: (message: string | null) => void;
};

export function useDashboardTasks({
  tasks,
  setTasks,
  isOnline,
  syncBridgeRef,
  previewGrowthForCompletion,
  applyServerGrowth,
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
  /** Counts taps per subtask, so a failed request only undoes ITS tap, never a newer one that happened to land on the same value. */
  const subtaskTapsRef = useRef(new Map<string, { tap: number; inFlight: number }>());
  /** Offline checklist writes per task, only while one is in flight: see toggleSubtask. */
  const taskWritesRef = useRef(
    new Map<
      string,
      { baseList: Subtask[]; latestList: Subtask[]; lastQueued: Subtask[] | null; inFlight: number; failed: boolean }
    >(),
  );

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

  const persistTasks = (updater: (current: Task[]) => Task[], skipSnapshot = false) => {
    setTasks((current) => {
      const next = updater(current);
      void setCachedTasks(next);
      if (!skipSnapshot) {
        void updateTodaySnapshot(next); // keep 7-day history in sync
      }
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

    // Refused before anything is sent, queued or stored; what the user typed stays in the form.
    const prepared = prepareSubtasks(createSubtasks);
    if (!prepared.ok) {
      setCreateSubtasksError(prepared.message);
      return;
    }
    setCreateSubtasksError(null);

    try {
      setCreatingTask(true);
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

      if (!isOnline) {
        const offlineTask = createOfflineTask(payload);
        persistTasks((current) => [offlineTask, ...current]);

        await enqueueSyncAction({
          type: 'create',
          taskId: offlineTask._id,
          payload,
        });
        await syncBridgeRef.current.refreshPendingQueueCount();

        syncBridgeRef.current.setSyncStatus('offline');
        setStatusInfo('Task saved offline. Pending sync.');
        setTitle('');
        setPriority('medium');
        setDueDate(getTodayDateString());
        setDueTime('');
        setStartTime('');
        setCreateTags(['personal']);
        setCreateTagInput('');
        setEstimatedMinutes('30');
        resetCreateExtras();
        return;
      }

      const response = await taskService.createTask(payload);

      persistTasks((current) => [{ ...response.task, pendingSync: false }, ...current]);
      setTitle('');
      setPriority('medium');
      setDueDate(getTodayDateString());
      setDueTime('');
      setStartTime('');
      setCreateTags(['personal']);
      setCreateTagInput('');
      setEstimatedMinutes('30');
      resetCreateExtras();
      setStatusInfo('Task created successfully.');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to create task');
    } finally {
      setCreatingTask(false);
    }
  };

  /**
   * Applies a completion transition to the local task copy, right now: `latestTasksRef` is advanced synchronously (a second tap
   * in the same tick builds on the first instead of repeating it), and the state and cache follow through persistTasks.
   */
  const applyLocalCompletion = (taskId: string, patch: Partial<Task>) => {
    const updatedAt = new Date().toISOString();
    latestTasksRef.current = latestTasksRef.current.map((item) =>
      item._id === taskId ? { ...item, ...patch, updatedAt, pendingSync: true } : item,
    );
    persistTasks((current) =>
      current.map((item) => (item._id === taskId ? { ...item, ...patch, updatedAt, pendingSync: true } : item)),
    );
  };

  /**
   * An online completion write failed. The event was created BEFORE the request and the request may have reached the server
   * (the answer can be the thing that was lost), so the event must not be dropped with the failed call: a manual retry would
   * make a NEW id and the server could end up with two completions for one user action. When the failure is one that can
   * still succeed later (no answer, 5xx, 408, 429, an expired session; the queue's own rule, `isPermanentError`), the SAME
   * entry is queued, never a rebuilt one, and the task shows what the user did, pending. A permanent 4xx (the server judged
   * the request itself invalid) is not queued: it would only be refused again.
   * Returns true when the event is now safely queued.
   */
  const queueCompletionAfterFailure = async (taskId: string, transition: CompletionTransition, failure: unknown): Promise<boolean> => {
    if (isPermanentError(failure)) return false;
    try {
      await enqueueCompletion(taskId, transition.entry);
    } catch {
      return false; // nothing was recorded: the caller reports the original failure
    }
    applyLocalCompletion(taskId, transition.localPatch);
    await syncBridgeRef.current.refreshPendingQueueCount();
    if (transition.completed) previewGrowthForCompletion(taskId);
    syncBridgeRef.current.setSyncStatus('offline');
    return true;
  };

  /**
   * Completing or re-opening a task (Issue #47, Phase 2E). ONE completion event is created here, from the LATEST state of the
   * task (not the object a render captured), and it is the same event whether the write goes out now (it rides the task
   * write) or waits in the queue (a `completion` entry): its id never changes, so a retry, a reload or a replay cannot make
   * a second record. A task that has not reached the server yet (a `local-*` id) is queued even while online.
   */
  const handleToggleTask = async (task: Task) => {
    setStatusError(null);
    setStatusInfo(null);

    const latest = latestTasksRef.current.find((item) => item._id === task._id) ?? task;
    const transition = makeCompletionTransition(latest);
    const nextCompleted = transition.completed;

    if (!isOnline || task._id.startsWith('local-')) {
      try {
        await enqueueCompletion(task._id, transition.entry);
      } catch {
        // Nothing was recorded, so the task is left as it was: an optimistic flip with no event behind it would be a lie.
        setStatusError('Could not queue the change — storage unavailable. Please try again.');
        return;
      }
      applyLocalCompletion(task._id, transition.localPatch);
      await syncBridgeRef.current.refreshPendingQueueCount();

      if (nextCompleted && !latest.completed) {
        previewGrowthForCompletion(task._id);
      }

      syncBridgeRef.current.setSyncStatus('offline');
      setStatusInfo(nextCompleted && !latest.completed ? 'Task updated offline. Pending sync. +10 XP' : 'Task updated offline. Pending sync.');
      return;
    }

    try {
      setActiveActionTaskId(task._id);
      const response = await taskService.updateTask(task._id, { completed: nextCompleted, completionEvent: transition.event });
      latestTasksRef.current = latestTasksRef.current.map((item) => (item._id === task._id ? keepReminderIdentity(response.task, item) : item));
      persistTasks((current) => current.map((item) => (item._id === task._id ? keepReminderIdentity(response.task, item) : item)));

      applyServerGrowth(response.growth);

      setStatusInfo(response.growth?.awarded ? 'Task completion updated. +10 XP' : 'Task completion updated.');
    } catch (requestError) {
      if (await queueCompletionAfterFailure(task._id, transition, requestError)) {
        setStatusInfo('Could not reach the server. Saved on this device and will sync. Pending sync.');
        return;
      }
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to update task');
    } finally {
      setActiveActionTaskId(null);
    }
  };

  /**
   * Sets ONE subtask's state (Issue #15). It works from the LATEST tasks, read when it is called (the ref is advanced
   * synchronously below, so two taps in the same tick build on each other), never from a task object a render captured.
   * An unknown task or subtask id does nothing, and no other subtask is ever changed. The whole next list is what is
   * sent or queued (the queue replaces an array whole, like `tags`), and the parent task's `completed` is never touched.
   */
  const toggleSubtask = async (taskId: string, subtaskId: string) => {
    const current = latestTasksRef.current.find((item) => item._id === taskId);
    if (!current) return;
    const before = getSubtasks(current);
    const target = before.find((subtask) => subtask.id === subtaskId);
    if (!target) return;

    const nextCompleted = !target.completed;
    const next = withSubtaskCompleted(before, subtaskId, nextCompleted);
    if (!next) return;

    setStatusError(null);
    setStatusInfo(null);

    /** Sets this subtask's state and nothing else about the task but `updatedAt`. */
    const applyState = (value: boolean) => (list: Task[]) =>
      list.map((item) => {
        if (item._id !== taskId) return item;
        const updated = withSubtaskCompleted(getSubtasks(item), subtaskId, value);
        // The task may have changed meanwhile (another edit, a sync): an id that is gone changes nothing.
        return updated ? { ...item, subtasks: updated, updatedAt: new Date().toISOString() } : item;
      });

    // Advance the ref now: effects only refresh it after a render, and a second tap can arrive before that.
    latestTasksRef.current = latestTasksRef.current.map((item) => (item._id === taskId ? { ...item, subtasks: next } : item));

    if (!isOnline) {
      // Every offline write queues the WHOLE list as it was at that tap, so a later list already contains earlier taps.
      // That is why a failure cannot undo "its own tap" in isolation: if a later write got queued, the failed tap is
      // already inside it. The record below is kept only while a write for this task is in flight, and the LAST write
      // to settle puts the CHECKLIST where the queue really is: the last list that was queued, or the list from before
      // the first write if none was (and only if nothing else has changed the checklist meanwhile).
      //
      // `pendingSync` is a different piece of state with a different owner: it belongs to whoever successfully queued
      // work for the task (this write, a task edit, a sync). So a toggle sets it only AFTER its own queue write
      // succeeded, and a failed toggle never touched it: there is nothing for a rollback to restore or trample.
      const writes =
        taskWritesRef.current.get(taskId) ?? { baseList: before, latestList: before, lastQueued: null, inFlight: 0, failed: false };
      taskWritesRef.current.set(taskId, writes);
      writes.inFlight += 1;
      writes.latestList = next;

      persistTasks(applyState(nextCompleted), true);
      let queued = false;
      try {
        await enqueueSyncAction({ type: 'update', taskId, payload: { subtasks: next } });
        queued = true;
        writes.lastQueued = next;
        persistTasks((list) => list.map((item) => (item._id === taskId ? { ...item, pendingSync: true } : item)), true);
        await syncBridgeRef.current.refreshPendingQueueCount();
      } catch {
        if (!queued) {
          writes.failed = true;
          setStatusError('Could not queue the change — storage unavailable. Please try again.');
        }
      } finally {
        writes.inFlight -= 1;
        if (writes.inFlight <= 0) {
          if (taskWritesRef.current.get(taskId) === writes) taskWritesRef.current.delete(taskId);
          if (writes.failed) {
            const restoreList = writes.lastQueued ?? writes.baseList;
            persistTasks(
              (list) =>
                list.map((item) =>
                  // Only if nothing else has changed the checklist since the last tap (an edit or a sync would win).
                  // The task's other fields, `pendingSync` included, are never part of this rollback.
                  item._id === taskId && sameSubtasks(getSubtasks(item), writes.latestList) ? { ...item, subtasks: restoreList } : item,
                ),
              true,
            );
          }
        }
      }
      if (queued) {
        syncBridgeRef.current.setSyncStatus('offline');
        if (!writes.failed) setStatusInfo('Subtask updated offline. Pending sync.');
      }
      return;
    }

    // Online: a counter per subtask lets a FAILED request undo only its own tap, never a newer one (even one that
    // landed on the same value). An entry lives only while a request for it is in flight.
    const tapKey = `${taskId}:${subtaskId}`;
    const taps = subtaskTapsRef.current.get(tapKey) ?? { tap: 0, inFlight: 0 };
    taps.tap += 1;
    taps.inFlight += 1;
    subtaskTapsRef.current.set(tapKey, taps);
    const tap = taps.tap;

    persistTasks(applyState(nextCompleted), true);
    try {
      const response = await taskService.updateTask(taskId, { subtasks: next });
      persistTasks((list) =>
        list.map((item) => {
          if (item._id !== taskId) return item;
          const adopted = keepReminderIdentity(response.task, item);
          // A newer local change to the checklist (another tap while this request was out) must not be overwritten by
          // this older response: keep the local list, adopt everything else the server says.
          return sameSubtasks(getSubtasks(item), next) ? adopted : { ...adopted, subtasks: getSubtasks(item) };
        }),
      );
      applyServerGrowth(response.growth);
    } catch (requestError) {
      // Put back only this subtask, and only if no newer tap has touched it since.
      if (subtaskTapsRef.current.get(tapKey)?.tap === tap) persistTasks(applyState(target.completed), true);
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to update subtask');
    } finally {
      taps.inFlight -= 1;
      if (taps.inFlight <= 0 && subtaskTapsRef.current.get(tapKey) === taps) subtaskTapsRef.current.delete(tapKey);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    setStatusError(null);
    setStatusInfo(null);

    if (!isOnline) {
      try {
        await enqueueSyncAction({
          type: 'delete',
          taskId,
        });
        await syncBridgeRef.current.refreshPendingQueueCount();
      } catch {
        setStatusError('Could not queue deletion — storage unavailable. Please try again.');
        return;
      }

      persistTasks((current) => current.filter((task) => task._id !== taskId));

      syncBridgeRef.current.setSyncStatus('offline');
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

    const currentTasks = latestTasksRef.current;
    const completedIds = currentTasks.filter((task) => task.completed).map((task) => task._id);

    if (completedIds.length === 0) {
      setStatusInfo('No completed tasks to clear.');
      return;
    }

    // Snapshot BEFORE deletion so "Completed Today" count survives clear.
    // Read the current tasks state synchronously via setTasks to avoid a
    // race where the passed-in `tasks` value may be stale if the user
    // completed items and immediately hit Clear Completed.
    await updateTodaySnapshot(currentTasks);

    if (!isOnline) {
      try {
        await Promise.all(
          completedIds.map((taskId) =>
            enqueueSyncAction({
              type: 'delete',
              taskId,
            }),
          ),
        );
        await syncBridgeRef.current.refreshPendingQueueCount();
      } catch {
        setStatusError('Could not queue deletion — storage unavailable. Please try again.');
        return;
      }

      persistTasks((current) => current.filter((task) => !completedIds.includes(task._id)), true);
      clearSelection();
      syncBridgeRef.current.setSyncStatus('offline');
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
        persistTasks((current) => current.filter((task) => !deletedIds.includes(task._id)), true);
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

    // One completion event per task, from the latest state of each (a task completed meanwhile is skipped, never completed twice).
    const transitions = incompleteTasks
      .map((task) => latestTasksRef.current.find((item) => item._id === task._id) ?? task)
      .filter((task) => !task.completed)
      .map((task) => ({ task, transition: makeCompletionTransition(task) }));

    if (!isOnline) {
      const queued: string[] = [];
      for (const { task, transition } of transitions) {
        try {
          await enqueueCompletion(task._id, transition.entry);
          applyLocalCompletion(task._id, transition.localPatch);
          queued.push(task._id);
        } catch {
          // This one was not recorded, so it is left as it was; the others are unaffected.
        }
      }
      await syncBridgeRef.current.refreshPendingQueueCount();

      queued.forEach((taskId) => {
        previewGrowthForCompletion(taskId);
      });

      clearSelection();
      syncBridgeRef.current.setSyncStatus('offline');
      if (queued.length < transitions.length) {
        setStatusError(`Could not queue ${transitions.length - queued.length} change${transitions.length - queued.length === 1 ? '' : 's'} — storage unavailable.`);
      }
      setStatusInfo(`Marked ${queued.length} task${queued.length === 1 ? '' : 's'} complete offline. +${queued.length * 10} XP`);
      return;
    }

    try {
      setBulkActionLoading(true);
      const results = await Promise.allSettled(
        transitions.map(({ task, transition }) => taskService.updateTask(task._id, { completed: true, completionEvent: transition.event })),
      );

      const updatedTasks: Task[] = [];
      const growths: GrowthResult[] = [];
      const failedIds: string[] = [];
      const queuedIds: string[] = [];

      // Sequential on purpose: each failed write is queued in order, from the SAME transition that was sent.
      for (const [index, result] of results.entries()) {
        const { task: sourceTask, transition } = transitions[index];

        if (result.status === 'fulfilled') {
          updatedTasks.push(result.value.task);
          if (result.value.growth) growths.push(result.value.growth);
        } else if (await queueCompletionAfterFailure(sourceTask._id, transition, result.reason)) {
          queuedIds.push(sourceTask._id);
        } else {
          failedIds.push(sourceTask._id);
        }
      }

      if (updatedTasks.length > 0) {
        const updatedById = new Map(updatedTasks.map((task) => [task._id, task]));
        persistTasks((current) => current.map((task) => updatedById.get(task._id) ?? task));

        // Responses can finish in any order; the server's XP only ever grows, so applying them from the
        // lowest XP up means the newest tree is the one that sticks (and stale ones are ignored anyway).
        [...growths]
          .sort((a, b) => a.treeState.xp - b.treeState.xp)
          .forEach((growth) => applyServerGrowth(growth));
      }

      setBulkFailedTaskIds(failedIds);

      if (failedIds.length > 0) {
        selectAll(failedIds);
      } else {
        clearSelection();
      }

      if (updatedTasks.length > 0 || queuedIds.length > 0) {
        const awardedXp = growths.reduce((sum, growth) => sum + growth.xpGained, 0);
        const marked = updatedTasks.length + queuedIds.length;
        setStatusInfo(
          `Marked ${marked} task${marked === 1 ? '' : 's'} complete.${awardedXp > 0 ? ` +${awardedXp} XP` : ''}${
            queuedIds.length > 0 ? ` ${queuedIds.length} saved on this device and will sync.` : ''
          }`,
        );
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
      try {
        await Promise.all(
          selectedVisibleIds.map((taskId) =>
            enqueueSyncAction({
              type: 'delete',
              taskId,
            }),
          ),
        );
        await syncBridgeRef.current.refreshPendingQueueCount();
      } catch {
        setStatusError('Could not queue deletion — storage unavailable. Please try again.');
        return;
      }

      persistTasks((current) => current.filter((task) => !selectedVisibleIds.includes(task._id)));
      clearSelection();
      syncBridgeRef.current.setSyncStatus('offline');
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
                dueTime: payload.dueTime ?? undefined,
                startTime: payload.startTime ?? undefined,
                estimatedMinutes: payload.estimatedMinutes ?? item.estimatedMinutes,
                ...(payload.description !== undefined ? { description: payload.description } : {}),
                ...(payload.subtasks !== undefined ? { subtasks: payload.subtasks } : {}),
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
      await syncBridgeRef.current.refreshPendingQueueCount();

      handleCancelEditing();
      syncBridgeRef.current.setSyncStatus('offline');
      setStatusInfo('Task edit saved offline. Pending sync.');
      return;
    }

    try {
      setActiveActionTaskId(taskId);
      const response = await taskService.updateTask(taskId, payload);

      persistTasks((current) => current.map((item) => (item._id === taskId ? keepReminderIdentity(response.task, item) : item)));
      applyServerGrowth(response.growth);
      handleCancelEditing();
      setStatusInfo('Task updated successfully.');
    } catch (requestError) {
      const axiosError = requestError as AxiosError<{ message?: string }>;
      setStatusError(axiosError.response?.data?.message ?? 'Unable to update task');
    } finally {
      setActiveActionTaskId(null);
    }
  };

  return {
    tasks,
    setTasks,
    persistTasks,

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
