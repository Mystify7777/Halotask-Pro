import { KeyboardEvent, useEffect, useMemo, useState } from 'react';
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
      if (current < 0) {
        return 0;
      }

      return Math.min(current, filteredSuggestions.length - 1);
    });
  }, [filteredSuggestions]);

  const commitTag = (rawTag: string) => {
    const result = onAddTag(rawTag);

    if (!result.message) {
      onInputValueChange('');
    }

    return result;
  };

  const selectSuggestion = (tag: string) => {
    commitTag(tag);
    setSuggestionsOpen(false);
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!filteredSuggestions.length) {
        return;
      }

      setSuggestionsOpen(true);
      setSuggestionIndex((current) => {
        const next = current + 1;
        return next >= filteredSuggestions.length ? 0 : next;
      });
      return;
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (!filteredSuggestions.length) {
        return;
      }

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

    if (event.key !== 'Enter' && event.key !== ',') {
      return;
    }

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
      return;
    }

    commitTag(normalized);
  };

  return (
    <div className="tag-input-block">
      <div className="chip-row">
        {suggestedTags.map((tag) => {
          const normalized = normalizeTag(tag);

          return (
            <button
              key={`suggested-${normalized}`}
              type="button"
              className={selectedTags.includes(normalized) ? 'tag-chip selected' : 'tag-chip'}
              onClick={() => toggleSuggestedTag(normalized)}
            >
              {toTitleCase(normalized)}
            </button>
          );
        })}
      </div>

      <div className="chip-row selected-row">
        {selectedTags.map((tag) => (
          <span key={`selected-${tag}`} className="selected-chip">
            {tag}
            <button type="button" onClick={() => onRemoveTag(tag)} aria-label={`Remove ${tag}`}>
              x
            </button>
          </span>
        ))}
      </div>

      <p className="tag-helper-text">{selectedTags.length}/{MAX_TAGS} tags used</p>

      <input
        type="text"
        value={inputValue}
        onChange={(event) => {
          onInputValueChange(event.target.value);
          setSuggestionsOpen(true);
        }}
        onFocus={() => {
          if (filteredSuggestions.length > 0) {
            setSuggestionsOpen(true);
          }
        }}
        onBlur={() => setSuggestionsOpen(false)}
        onKeyDown={handleInputKeyDown}
        placeholder={placeholder}
      />

      {suggestionsOpen && filteredSuggestions.length > 0 && (
        <div className="tag-suggestion-dropdown">
          {filteredSuggestions.map((tag, index) => (
            <button
              key={`suggestion-${tag}`}
              type="button"
              className={index === suggestionIndex ? 'suggestion-item active' : 'suggestion-item'}
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
