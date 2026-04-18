import { useMemo } from 'react';
import { Task } from '../types/task';
import { normalizeTag } from '../utils/tagHelpers';

export const useTagSuggestions = (tasks: Task[], inputValue: string, selectedTags: string[]) => {
  const tagUsage = useMemo(() => {
    const usage = new Map<string, number>();

    for (const task of tasks) {
      for (const rawTag of task.tags) {
        const normalized = normalizeTag(rawTag);

        if (!normalized) {
          continue;
        }

        usage.set(normalized, (usage.get(normalized) ?? 0) + 1);
      }
    }

    return usage;
  }, [tasks]);

  return useMemo(() => {
    const normalizedInput = normalizeTag(inputValue);

    return Array.from(tagUsage.entries())
      .filter(([tag]) => {
        if (selectedTags.includes(tag)) {
          return false;
        }

        if (!normalizedInput) {
          return true;
        }

        return tag.includes(normalizedInput);
      })
      .sort((a, b) => {
        if (b[1] !== a[1]) {
          return b[1] - a[1];
        }

        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5)
      .map(([tag]) => tag);
  }, [tagUsage, inputValue, selectedTags]);
};
