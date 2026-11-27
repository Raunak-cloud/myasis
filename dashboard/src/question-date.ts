import type { QuestionControl, QuestionResponse, QuestionValue } from '../../seek-bot/src/question-snapshot';
import { questionValueIssue, questionValueNumber } from '../../seek-bot/src/question-value';

const birthDateLabel = /\b(?:date[\s-]+of[\s-]+birth|birth[\s-]*date|d\.?o\.?b\.?)\b/i;
const dateLabel = /\b(?:date of (?:issue|expiry|expiration|completion|graduation)|(?:start|end|commencement|availability|graduation|expiry|expiration|renewal|issue|effective) date)\b/i;
const dateParts = ['year', 'month', 'day'] as const;
type DatePart = typeof dateParts[number];

const partLabels: Record<DatePart, RegExp> = {
  year: /^(?:year|yyyy)$/i,
  month: /^(?:month|mm)$/i,
  day: /^(?:day|dd)$/i,
};
const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const numericPart = (value: string) => /^\d+$/.test(value.trim()) ? Number(value) : undefined;
const dateWidth: Record<DatePart, number> = { year: 4, month: 2, day: 2 };

export function dateInputKind(control: QuestionControl, prompt?: string) {
  const label = `${control.label} ${prompt ?? ''}`;
  const birthday = birthDateLabel.test(label);
  const hasOtherFormat = /\b(?:dd(?:[/.\s-]?mm)[/.\s-]?yyyy|mm(?:[/.\s-]?dd)[/.\s-]?yyyy|yyyy[/.]mm[/.]dd)\b/i.test(label);
  const textDate = control.kind === 'text' && (birthday || dateLabel.test(label)) && !hasOtherFormat
    && control.constraints.pattern === undefined && (control.constraints.minLength ?? 0) <= 10 && (control.constraints.maxLength ?? 4000) >= 10;
  return { type: textDate ? 'date' : control.kind, autoComplete: birthday && (textDate || control.kind === 'date') ? 'bday' : undefined };
}

function partChoiceNumber(choice: QuestionControl['choices'][number], part: DatePart) {
  const label = choice.label.trim().toLowerCase();
  if (part === 'month') {
    const index = monthNames.findIndex(name => name === label || name.slice(0, 3) === label);
    if (index >= 0) return index + 1;
  }
  return numericPart(label) ?? numericPart(choice.value);
}

function selectedPart(control: QuestionControl, part: DatePart, value: QuestionValue | undefined) {
  if (typeof value !== 'string') return undefined;
  if (control.kind !== 'select') return numericPart(value);
  const choice = control.choices.find(option => option.id === value);
  return choice ? partChoiceNumber(choice, part) : undefined;
}

function originalPartValue(control: QuestionControl, part: DatePart, value: string): string | undefined {
  if (control.kind !== 'select') {
    const formatted = control.kind === 'number' ? String(Number(value)) : value;
    return questionValueIssue(control, formatted) === null ? formatted : undefined;
  }
  const choices = control.choices.filter(choice => !choice.disabled && !choice.hidden && !choice.placeholder
    && partChoiceNumber(choice, part) === Number(value));
  return choices.length === 1 ? choices[0].id : undefined;
}

/** Present a full captured date as one calendar while retaining the employer's response schema. */
export function splitDateInput(controls: QuestionControl[]) {
  if (controls.length !== dateParts.length) return undefined;
  const parts = dateParts.map(part => {
    const control = controls.find(item => partLabels[part].test(item.label.replace(/\*/g, '').trim()));
    if (!control || control.multiple || !['select', 'number', 'text'].includes(control.kind)) return undefined;
    if (control.kind === 'text' && (control.constraints.pattern || (control.constraints.maxLength ?? 4000) < dateWidth[part])) return undefined;
    return { part, control };
  });
  if (parts.some(part => part === undefined)) return undefined;
  const bindings = parts.filter(part => part !== undefined);
  return {
    read(value: QuestionResponse) {
      const selected = bindings.map(({ part, control }) => selectedPart(control, part, value[control.id]));
      if (selected.some(part => part === undefined)) return '';
      const date = selected.map((part, i) => String(part).padStart(dateWidth[bindings[i].part], '0')).join('-');
      return questionValueNumber('date', date) === null ? '' : date;
    },
    write(date: string): QuestionResponse | undefined {
      if (questionValueNumber('date', date) === null) return undefined;
      const values = date.split('-');
      const response: QuestionResponse = {};
      for (const [i, { part, control }] of bindings.entries()) {
        const value = originalPartValue(control, part, values[i]);
        if (value === undefined) return undefined;
        response[control.id] = value;
      }
      return response;
    },
  };
}

export function dateAutocomplete(prompt: string) {
  return birthDateLabel.test(prompt) ? 'bday' : undefined;
}
