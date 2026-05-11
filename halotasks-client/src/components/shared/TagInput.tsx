import { KeyboardEvent, useEffect, useId, useMemo, useState } from 'react';
import { MAX_TAGS, normalizeTag, toTitleCase } from '../../utils/tagHelpers';

type AddTagResult = {
  message: string | null;
};

type TagInputProps = {
  selectedTags: string[];
  inputValue: string;
  onInputValueChange: (value: string) => void;
  onAddTag: (tag: string) => AddTagResult;
  onRemoveTag: (tag: string) => void;
  suggestedTags: readonly string[];
  dynamicSuggestions: string[];
  placeholder: string;
};

export default function TagInput({
  selectedTags,
  inputValue,
  onInputValueChange,
  onAddTag,
  onRemoveTag,
  suggestedTags,
  dynamicSuggestions,
  placeholder,
}: TagInputProps) {
  const uid = useId();
  const listboxId = `${uid}-listbox`;

  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);

  const filteredSuggestions = useMemo(() => {
    const selected = new Set(selectedTags);
    return dynamicSuggestions.filter((tag) => !selected.has(tag));
  }, [dynamicSuggestions, selectedTags]);

  useEffect(() => {
    if (!filteredSuggestions.length) {
      setSuggestionIndex(-1);
      return;
    }
    setSuggestionIndex((current) => {
      if (current < 0) return 0;
      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions]);

  const commitTag = (rawTag: string) => {
    const result = onAddTag(rawTag);
    if (!result.message) onInputValueChange('');
    return result;
  };

  const selectSuggestion = (tag: string) => {
    commitTag(tag);
    setSuggestionsOpen(false);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!filteredSuggestions.length) return;
      setSuggestionsOpen(true);
      setSuggestionIndex((current) => {
        const next = current + 1;
        return next >= filteredSuggestions.length ? 0 : next;
      });
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filteredSuggestions.length) return;
      setSuggestionsOpen(true);
      setSuggestionIndex((current) => {
        const base = current < 0 ? 0 : current;
        const next = base - 1;
        return next < 0 ? filteredSuggestions.length - 1 : next;
      });
      return;
    }

    if (event.key === 'Escape') {
      setSuggestionsOpen(false);
      return;
    }

    if (event.key === 'Backspace' && !inputValue.trim() && selectedTags.length > 0) {
      event.preventDefault();
      onRemoveTag(selectedTags[selectedTags.length - 1]);
      return;
    }

    if (event.key !== 'Enter' && event.key !== ',') return;

    event.preventDefault();

    if (event.key === 'Enter' && suggestionsOpen && suggestionIndex >= 0) {
      const suggestion = filteredSuggestions[suggestionIndex];
      if (suggestion) {
        selectSuggestion(suggestion);
      }
      return;
    }

    commitTag(inputValue);
    setSuggestionsOpen(false);
  };

  const toggleSuggestedTag = (tag: string) => {
    const normalized = normalizeTag(tag);
    if (selectedTags.includes(normalized)) {
      onRemoveTag(normalized);
    } else {
      commitTag(normalized);
    }
  };

  const isDropdownOpen = suggestionsOpen && filteredSuggestions.length > 0;
  const activeDescendant =
    isDropdownOpen && suggestionIndex >= 0
      ? `${uid}-opt-${suggestionIndex}`
      : undefined;

  return (
    <div className="tag-input-block">
      {/* Quick-select preset tags */}
      <div className="chip-row" role="group" aria-label="Preset tags">
        {suggestedTags.map((tag) => {
          const normalized = normalizeTag(tag);
          const isSelected = selectedTags.includes(normalized);
          return (
            <button
              key={`suggested-${normalized}`}
              type="button"
              className={isSelected ? 'tag-chip selected' : 'tag-chip'}
              onClick={() => toggleSuggestedTag(normalized)}
              aria-pressed={isSelected}
            >
              {toTitleCase(normalized)}
            </button>
          );
        })}
      </div>

      {/* Chosen tags */}
      {selectedTags.length > 0 && (
        <div className="chip-row selected-row" aria-label="Selected tags">
          {selectedTags.map((tag) => (
            <span key={`selected-${tag}`} className="selected-chip">
              {tag}
              <button type="button" onClick={() => onRemoveTag(tag)} aria-label={`Remove tag ${tag}`}>
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <p className="tag-helper-text" aria-live="polite">
        {selectedTags.length}/{MAX_TAGS} tags used
      </p>

      {/* Combobox input */}
      <input
        type="text"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={isDropdownOpen}
        aria-controls={listboxId}
        aria-activedescendant={activeDescendant}
        value={inputValue}
        onChange={(event) => {
          onInputValueChange(event.target.value);
          setSuggestionsOpen(true);
        }}
        onFocus={() => {
          if (filteredSuggestions.length > 0) setSuggestionsOpen(true);
        }}
        onBlur={() => setSuggestionsOpen(false)}
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
      />

      {/* Suggestion dropdown */}
      {isDropdownOpen && (
        <div
          id={listboxId}
          className="tag-suggestion-dropdown"
          role="listbox"
          aria-label="Tag suggestions"
        >
          {filteredSuggestions.map((tag, index) => (
            <button
              key={`suggestion-${tag}`}
              id={`${uid}-opt-${index}`}
              type="button"
              className={index === suggestionIndex ? 'suggestion-item active' : 'suggestion-item'}
              role="option"
              aria-selected={index === suggestionIndex}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => selectSuggestion(tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
