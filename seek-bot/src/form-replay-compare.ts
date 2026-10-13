import type { FormExpectation } from './form-corpus.js';

const meaningless = (label: string) =>
  !label.trim() || label === 'unlabelled field' || /^[\s\-–—.*]*(?:none|n\/a|select|choose|please (?:select|choose)|select an option|select one|--)[\s\-–—.*]*$/i.test(label);

export interface Finding { page: string; kind: 'regression' | 'change'; detail: string }

export function compareFormExpectations(name: string, before: FormExpectation, now: FormExpectation): Finding[] {
  const findings: Finding[] = [];
  const regression = (detail: string) => findings.push({ page: name, kind: 'regression', detail });
  const change = (detail: string) => findings.push({ page: name, kind: 'change', detail });
  if (now.fields.length < before.fields.length) regression(`fields found: ${before.fields.length} → ${now.fields.length}`);
  else if (now.fields.length > before.fields.length) change(`fields found: ${before.fields.length} → ${now.fields.length}`);
  // Pair known questions before using positions for changed wording. A
  // reordered question must not inherit a different question's field type.
  // Consume matches once so duplicate labels still preserve multiplicity.
  const available = new Set(now.fields.map((_, index) => index));
  const matches = new Map<number, number>();
  for (const [index, was] of before.fields.entries()) {
    const candidates = [...available].filter(at => now.fields[at].label === was.label);
    const matched = candidates.find(at => now.fields[at].kind === was.kind && now.fields[at].required === was.required)
      ?? candidates.find(at => now.fields[at].kind === was.kind) ?? candidates[0];
    if (matched !== undefined) { matches.set(index, matched); available.delete(matched); }
  }
  for (const [index] of before.fields.entries()) {
    if (matches.has(index)) continue;
    const matched = available.has(index) ? index : available.values().next().value;
    if (matched !== undefined) { matches.set(index, matched); available.delete(matched); }
  }
  if ([...matches].some(([beforeAt, nowAt]) => beforeAt !== nowAt)) change('field order changed; questions compared by label');
  for (const [index, was] of before.fields.entries()) {
    const matched = matches.get(index);
    const is = matched === undefined ? undefined : now.fields[matched];
    if (!is) continue;
    if (!meaningless(was.label) && meaningless(is.label)) regression(`field ${index + 1} lost its label: "${was.label}" → "${is.label}"`);
    else if (was.label !== is.label) change(`field ${index + 1} label: "${was.label}" → "${is.label}"`);
    if (was.required && !is.required) regression(`field ${index + 1} ("${is.label}") lost its required status`);
    if (was.kind !== is.kind) regression(`field ${index + 1} ("${is.label}") kind: ${was.kind} → ${is.kind}`);
  }
  if (before.captcha !== now.captcha) regression(`security check ${before.captcha ? 'no longer seen' : 'now seen'}`);
  if (before.coverLetterOffered && !now.coverLetterOffered) regression('place for a cover letter no longer seen');
  else if (!before.coverLetterOffered && now.coverLetterOffered) change('place for a cover letter now seen');
  return findings;
}

