export const SUGGESTED_TAGS = ['work', 'study', 'health', 'personal', 'urgent', 'finance'] as const;
export const MAX_TAGS = 5;
export const MAX_TAG_LENGTH = 20;

export const toTitleCase = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

export const normalizeTag = (value: string) => value.trim().toLowerCase().slice(0, MAX_TAG_LENGTH);

export const sanitizeTags = (tags: string[]) => {
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

export const tryAddTag = (currentTags: string[], rawValue: string) => {
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
