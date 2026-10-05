import {
  DESCRIPTION_MAX_LENGTH,
  TAGS_MAX_COUNT,
  TAG_MAX_LENGTH,
  TITLE_MAX_LENGTH,
  isValidEstimatedMinutes,
  isValidPriority,
  type TaskPriority,
} from './taskValidators';
import { BODY_MUST_BE_OBJECT, isPlainObject } from './requestBody';

// ── AI task parsing: request validation, prompt, and model-output sanitising ──
//
// POST /api/ai/parse-tasks  body: { prompt: string }   (auth required)
//   - prompt: non-empty after trimming, at most AI_PROMPT_MAX_LENGTH characters.
//   - Any other field (provider, model, url, temperature, ...) is ignored: the provider, model and
//     endpoint are server-side constants and can never be chosen by the caller.
// 200 → { tasks: AiTaskDraft[] }   (possibly empty: "no actionable tasks found")

export const AI_PROMPT_MAX_LENGTH = 2000;
/** Upper bound on drafts returned from one prompt, so a runaway model response stays bounded. */
export const AI_MAX_TASKS = 20;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date in YYYY-MM-DD form (rejects 2026-02-30 and any other shape). */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

export type AiTaskDraft = {
  title: string;
  priority: TaskPriority;
  dueDate?: string;
  estimatedMinutes?: number;
  tags: string[];
  description: string;
};

export type AiPromptResult = { ok: true; prompt: string } | { ok: false; message: string };

export function parseAiPromptBody(body: unknown): AiPromptResult {
  if (!isPlainObject(body)) {
    return { ok: false, message: BODY_MUST_BE_OBJECT };
  }

  const { prompt } = body;
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return { ok: false, message: 'prompt is required and must be a non-empty string.' };
  }

  const trimmed = prompt.trim();
  if (trimmed.length > AI_PROMPT_MAX_LENGTH) {
    return { ok: false, message: `prompt must be at most ${AI_PROMPT_MAX_LENGTH} characters.` };
  }

  return { ok: true, prompt: trimmed };
}

/** Same instructions the browser used to send; "today" is the server's UTC date, as before. */
export function buildTaskParsingPrompt(input: string, now: Date = new Date()): string {
  const today = now.toISOString().split('T')[0];

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

/**
 * Turns the model's raw text into validated drafts. Returns null when the text is not a JSON array
 * at all (an upstream-contract failure); individual malformed fields are dropped or defaulted
 * rather than failing the whole request, mirroring what the client used to do.
 */
export function parseModelOutput(raw: string): AiTaskDraft[] | null {
  const clean = raw.replace(/```json|```/g, '').trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(clean);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const drafts: AiTaskDraft[] = [];
  for (const item of parsed.slice(0, AI_MAX_TASKS)) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const task = item as Record<string, unknown>;

    const title = typeof task.title === 'string' ? task.title.trim().slice(0, TITLE_MAX_LENGTH) : '';

    const tags = Array.isArray(task.tags)
      ? task.tags
          .filter((tag): tag is string => typeof tag === 'string')
          .map((tag) => tag.trim().slice(0, TAG_MAX_LENGTH))
          .filter((tag) => tag.length > 0)
          .slice(0, TAGS_MAX_COUNT)
      : [];

    const draft: AiTaskDraft = {
      title: title || 'Untitled task',
      priority: isValidPriority(task.priority) ? task.priority : 'medium',
      tags,
      description:
        typeof task.description === 'string' ? task.description.slice(0, DESCRIPTION_MAX_LENGTH) : '',
    };

    if (isIsoDate(task.dueDate)) draft.dueDate = task.dueDate;
    if (typeof task.estimatedMinutes === 'number' && isValidEstimatedMinutes(task.estimatedMinutes)) {
      draft.estimatedMinutes = task.estimatedMinutes;
    }

    drafts.push(draft);
  }

  return drafts;
}
