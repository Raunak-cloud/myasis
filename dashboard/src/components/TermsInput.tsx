import { useRef, useState } from 'react';

/** The saved form is a comma-separated string; the terms are what a person edits. */
export function splitTerms(value: string): string[] {
  return value.split(/[,\r\n]+/).map((term) => term.trim()).filter(Boolean);
}

/**
 * Short lists as removable tags.
 *
 * A comma-separated textarea asked people to manage punctuation to edit a
 * list, and hid most of the list behind a scrollbar. Each term is a tag here:
 * Enter or a comma adds one, Backspace in the empty box removes the last, and
 * pasting a comma-separated list adds each part. Duplicates are dropped
 * quietly; anything past the limit is refused with a visible error, and
 * additions and removals are announced to screen readers.
 */
export function TermsInput({
  id,
  value,
  onChange,
  max,
  disabled = false,
  dataField,
  itemLabel = 'job title',
  emptyPlaceholder,
  ariaLabel,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  max?: number;
  disabled?: boolean;
  /** Lets a form's validation scroll to and focus this field. */
  dataField?: string;
  /** Singular name used by the placeholder and accessible limit message. */
  itemLabel?: string;
  emptyPlaceholder?: string;
  ariaLabel?: string;
}) {
  const terms = splitTerms(value);
  const [draft, setDraft] = useState('');
  const [announcement, setAnnouncement] = useState('');
  const [limitError, setLimitError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const full = max !== undefined && terms.length >= max;

  const overLimit = `You can have at most ${max} ${itemLabel}${max === 1 ? '' : 's'}. Remove one to add another.`;

  function commit(raw: string) {
    const next = [...terms];
    let refused = false;
    for (const term of splitTerms(raw)) {
      if (next.some((known) => known.toLowerCase() === term.toLowerCase())) continue;
      if (max !== undefined && next.length >= max) refused = true;
      else next.push(term);
    }
    setDraft('');
    setLimitError(refused ? overLimit : '');
    const added = next.slice(terms.length);
    if (!added.length) return;
    onChange(next.join(', '));
    setAnnouncement(`Added ${added.join(', ')}`);
  }

  function remove(index: number) {
    const removed = terms[index];
    onChange(terms.filter((_, position) => position !== index).join(', '));
    setLimitError('');
    setAnnouncement(`Removed ${removed}`);
    inputRef.current?.focus();
  }

  return (
    <>
    <div
      className={`terms-input${disabled ? ' disabled' : ''}`}
      onClick={(event) => {
        if (event.target === event.currentTarget) inputRef.current?.focus();
      }}
    >
      {terms.map((term, index) => (
        <span className="terms-chip" key={`${term}-${index}`}>
          <span>{term}</span>
          <button type="button" aria-label={`Remove ${term}`} disabled={disabled} onClick={() => remove(index)}>
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </span>
      ))}
      <input
        id={id}
        ref={inputRef}
        data-field={dataField}
        className="terms-entry"
        aria-label={ariaLabel}
        value={draft}
        disabled={disabled}
        aria-describedby={full ? `${id}-limit` : undefined}
        placeholder={full ? `Limit of ${max} reached` : terms.length ? 'Add another' : emptyPlaceholder ?? `Type a ${itemLabel} and press Enter`}
        onChange={(event) => {
          // At the limit the box stays usable, so Backspace can still remove a tag; new text is refused out loud.
          if (full) return setLimitError(event.target.value.trim() ? overLimit : '');
          const next = event.target.value;
          if (next.includes(',')) commit(next);
          else setDraft(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit(draft);
          } else if (event.key === 'Backspace' && !draft && terms.length) {
            remove(terms.length - 1);
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
      />
      {full && <span className="sr-only" id={`${id}-limit`}>Limit of {max} reached. Remove one to add another.</span>}
      <span className="sr-only" aria-live="polite">{announcement}</span>
    </div>
    {limitError && <span className="field-error" role="alert">{limitError}</span>}
    </>
  );
}
