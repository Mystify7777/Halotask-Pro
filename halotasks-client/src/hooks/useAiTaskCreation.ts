import { useState } from 'react';
import { aiService, type ParsedAiTask } from '../services/aiService';
import { getApiErrorMessage } from '../services/api';
import { taskService } from '../services/taskService';
import type { Priority, Task, TaskCreatePayload } from '../types/task';
import { sanitizeTags } from '../utils/tagHelpers';

export type AiPhase = 'idle' | 'input' | 'parsing' | 'preview' | 'creating';

export interface AiTaskDraft {
  id: string;
  title: string;
  priority: Priority;
  dueDate?: string;
  estimatedMinutes?: number;
  tags: string[];
  description: string;
}

const VALID_PRIORITIES: Priority[] = ['low', 'medium', 'high'];

type UseAiTaskCreationArgs = {
  persistTasks: (updater: (prev: Task[]) => Task[]) => void;
  isOnline: boolean;
  setStatusInfo: (msg: string | null) => void;
  setStatusError: (msg: string | null) => void;
};

export function useAiTaskCreation({
  persistTasks,
  isOnline,
  setStatusInfo,
  setStatusError,
}: UseAiTaskCreationArgs) {
  const [phase, setPhase] = useState<AiPhase>('idle');
  const [prompt, setPrompt] = useState('');
  const [drafts, setDrafts] = useState<AiTaskDraft[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [createdCount, setCreatedCount] = useState(0);
  const [totalDrafts, setTotalDrafts] = useState(0);

  const openAi = () => {
    setPhase('input');
    setPrompt('');
    setDrafts([]);
    setAiError(null);
    setCreatedCount(0);
    setTotalDrafts(0);
  };

  const closeAi = () => {
    setPhase('idle');
    setPrompt('');
    setDrafts([]);
    setAiError(null);
    setCreatedCount(0);
    setTotalDrafts(0);
  };

  const parsePrompt = async () => {
    if (!prompt.trim()) {
      return;
    }

    setPhase('parsing');
    setAiError(null);

    try {
      const parsed: ParsedAiTask[] = await aiService.parseTasks(prompt.trim());

      if (parsed.length === 0) {
        setAiError('Couldn\'t find any tasks in that input. Try being more specific, e.g. "Book dentist appointment next Tuesday, high priority."');
        setPhase('input');
        return;
      }

      const withIds: AiTaskDraft[] = parsed.map((task, index) => ({
        id: `ai-${Date.now()}-${index}`,
        title: task.title?.trim() || 'Untitled task',
        priority: VALID_PRIORITIES.includes(task.priority as Priority) ? (task.priority as Priority) : 'medium',
        dueDate: task.dueDate,
        estimatedMinutes: typeof task.estimatedMinutes === 'number' ? task.estimatedMinutes : undefined,
        tags: sanitizeTags(Array.isArray(task.tags) ? task.tags.map((tag) => String(tag)) : ['personal']),
        description: task.description ?? '',
      }));

      setDrafts(withIds);
      setPhase('preview');
    } catch (error) {
      setAiError(getApiErrorMessage(error, 'Failed to parse tasks. Please try again.'));
      setPhase('input');
    }
  };

  const removeDraft = (id: string) => {
    setDrafts((current) => current.filter((draft) => draft.id !== id));
  };

  const createAll = async () => {
    if (!isOnline) {
      setStatusError('You must be online to create tasks with AI.');
      return;
    }

    if (drafts.length === 0) {
      return;
    }

    setTotalDrafts(drafts.length);
    setPhase('creating');
    setCreatedCount(0);

    const created: Task[] = [];

    for (const draft of drafts) {
      const payload: TaskCreatePayload = {
        title: draft.title,
        priority: draft.priority,
        tags: draft.tags,
        dueDate: draft.dueDate,
        estimatedMinutes: draft.estimatedMinutes,
        description: draft.description,
      };

      try {
        const response = await taskService.createTask(payload);
        created.push({ ...response.task, pendingSync: false });
        setCreatedCount((current) => current + 1);
      } catch {
        // Skip failed drafts so users can retry or edit them manually.
      }
    }

    if (created.length > 0) {
      persistTasks((current) => [...[...created].reverse(), ...current]);
      setStatusInfo(`✨ ${created.length} task${created.length === 1 ? '' : 's'} created with AI.`);
    }

    closeAi();
  };

  return {
    aiPhase: phase,
    aiPrompt: prompt,
    setAiPrompt: setPrompt,
    aiDrafts: drafts,
    aiError,
    aiCreatedCount: createdCount,
    aiTotalDrafts: totalDrafts,
    openAi,
    closeAi,
    parsePrompt,
    removeDraft,
    createAll,
  };
}
