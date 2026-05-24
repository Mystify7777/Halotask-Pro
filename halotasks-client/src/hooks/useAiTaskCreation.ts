import { useState } from 'react';
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

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const VALID_PRIORITIES: Priority[] = ['low', 'medium', 'high'];

function buildPrompt(input: string): string {
  const today = new Date().toISOString().split('T')[0];

  return `You are a task parser. Today is ${today}.

Parse the following text into a JSON array of task objects. Each object must include:
- "title"             — string, concise action phrase (required)
- "priority"          — "low" | "medium" | "high" (infer from urgency; default "medium")
- "dueDate"           — ISO date "YYYY-MM-DD" resolving relative terms like "tomorrow" or "next Friday" against today; omit entirely if not mentioned
- "estimatedMinutes"  — number, infer from context; omit if unclear
- "tags"              — string array with at least one tag inferred from context
- "description"       — any extra detail not captured in the title; empty string if none

Rules:
• Split compound inputs into separate tasks.
• Return ONLY a valid JSON array — no markdown fences, no prose, no explanation.
• If the text contains no actionable tasks, return [].

Text: "${input.replace(/"/g, '\\"')}"`;
}

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

    const apiKey = import.meta.env.VITE_GEMINI_API_KEY as string | undefined;

    if (!apiKey) {
      setAiError('No Gemini API key found. Add VITE_GEMINI_API_KEY to your .env file and restart the dev server.');
      return;
    }

    setPhase('parsing');
    setAiError(null);

    try {
      const response = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(prompt) }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 1024 },
        }),
      });

      if (!response.ok) {
        const errorData = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
        throw new Error(errorData?.error?.message ?? `Gemini error ${response.status}`);
      }

      const data = (await response.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      };

      const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]';
      const clean = raw.replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(clean) as Partial<AiTaskDraft>[];

      if (!Array.isArray(parsed) || parsed.length === 0) {
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
      setAiError(error instanceof Error ? error.message : 'Failed to parse tasks. Please try again.');
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
