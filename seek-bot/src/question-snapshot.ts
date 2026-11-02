import { questionValueIssue } from './question-value.js';
/** Browser-safe wire contract. Display copy is never the deduplication key.
 * A snapshot describes employer markup, not the candidate's current values. */
export type QuestionInput = 'text' | 'search' | 'textarea' | 'select' | 'radio' | 'checkbox' | 'checkbox-group' | 'date' | 'month' | 'week' | 'time' | 'datetime-local' | 'number' | 'range' | 'color' | 'email' | 'tel' | 'url' | 'file';
export interface QuestionChoice { id: string; label: string; value: string; disabled: boolean; group?: string; required?: boolean; hidden?: boolean; placeholder?:boolean }
export interface QuestionControl {
  id: string; label: string; kind: QuestionInput; required: boolean; multiple: boolean;
  choices: QuestionChoice[];
  constraints: { min?: string; max?: string; step?: string; stepBase?: string; pattern?: string; maxLength?: number; minLength?: number; size?:number; accept?: string };
}
export interface QuestionSnapshot {
  version: 2; id: string; revision: string;
  source: { origin: string; path: string };
  prompt: string; context: string[]; help: string[]; controls: QuestionControl[];
  completeness: 'complete' | 'recapture';
}
export type QuestionValue = string | string[] | boolean;
export type QuestionResponse = Record<string, QuestionValue>;
export interface CapturedQuestion {
  question: string; prompt?: string; snapshot?: QuestionSnapshot;
  /** Read-only legacy metadata. It cannot prove an original control catalog. */
  kind?: 'text'|'textarea'|'select'|'radio'|'checkbox'; options?: string[];
}
const kinds = new Set<string>(['text','search','textarea','select','radio','checkbox','checkbox-group','date','month','week','time','datetime-local','number','range','color','email','tel','url','file']);
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown, max = 4000): v is string => typeof v === 'string' && v.length <= max;
const strings = (v: unknown): v is string[] => Array.isArray(v) && v.length <= 30 && v.every(x => text(x));

/** Reject malformed versioned data rather than quietly degrading it to text. */
export function isQuestionSnapshot(v: unknown): v is QuestionSnapshot {
  if (!record(v) || v.version !== 2 || !text(v.id, 68) || !/^q2_[a-f0-9]{64}$/.test(v.id)
    || !text(v.revision,64) || !/^[a-f0-9]{64}$/.test(v.revision) || !record(v.source)
    || !text(v.source.origin, 500) || !text(v.source.path, 2000) || !text(v.prompt) || !v.prompt.trim()
    || !strings(v.context) || !strings(v.help) || !['complete','recapture'].includes(String(v.completeness))
    || !Array.isArray(v.controls) || !v.controls.length || v.controls.length > 30) return false;
  const ids = new Set<string>();
  return v.controls.every(c => {
    if (!record(c) || !text(c.id,30) || !/^part\d+$/.test(c.id) || ids.has(c.id) || !text(c.label)
      || !kinds.has(String(c.kind)) || typeof c.required !== 'boolean' || typeof c.multiple !== 'boolean'
      || !Array.isArray(c.choices) || c.choices.length > 5000 || !record(c.constraints)) return false;
    ids.add(c.id);
    if (!Object.entries(c.constraints).every(([k,x]) => ['maxLength','minLength','size'].includes(k)
      ? typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 && x <= 1000000
      : ['min','max','step','stepBase','pattern','accept'].includes(k) && text(x))) return false;
    const choices = new Set<string>();
    return c.choices.every(o => {
      if (!record(o) || !text(o.id,30) || !/^choice\d+$/.test(o.id) || choices.has(o.id)
        || !text(o.label) || !text(o.value) || typeof o.disabled !== 'boolean' || (o.group !== undefined && !text(o.group)) || (o.required !== undefined && typeof o.required!=='boolean') || (o.hidden!==undefined&&typeof o.hidden!=='boolean') || (o.placeholder!==undefined&&typeof o.placeholder!=='boolean')) return false;
      choices.add(o.id); return true;
    });
  });
}

/** Semantic identity excludes transient DOM references and candidate values.
 * Revision includes exact copy, choices/order and constraints. Changes cannot
 * reuse stale responses even if the underlying question remains the same. */
export function questionIdentity(s: Omit<QuestionSnapshot,'id'|'revision'>): string {
  const norm = (v: string) => v.normalize('NFKC').replace(/\s+/g,' ').replace(/[\s*]+$/,'').trim().toLowerCase();
  return JSON.stringify([s.source.origin, s.source.path, s.context.map(norm), norm(s.prompt)]);
}
export function questionRevision(s: Omit<QuestionSnapshot,'id'|'revision'>): string {
  return JSON.stringify([questionIdentity(s),s.prompt,s.context,s.help,s.completeness,s.controls.map(c => [c.id,c.label,c.kind,c.required,c.multiple,c.choices.map(o => [o.id,o.label,o.value,o.disabled,o.group ?? '',o.required??false,o.hidden??false,o.placeholder??false]),Object.entries(c.constraints).sort(([a],[b])=>a.localeCompare(b))])]);
}

export function questionAnswerable(s:QuestionSnapshot):boolean {
  return s.completeness==='complete'&&!s.controls.some(c=>c.kind==='file'
    || ['radio','select','checkbox-group'].includes(c.kind)&&!c.choices.some(o=>!o.disabled&&!o.hidden&&!(c.required&&o.placeholder)));
}
export function questionResponseIssue(s: QuestionSnapshot, raw: unknown): string | null {
  if (!questionAnswerable(s)) return 'This question must be captured again before it can be answered.';
  if (!record(raw) || Object.keys(raw).length !== s.controls.length || Object.keys(raw).some(k => !s.controls.some(c => c.id === k))) return 'Answer every part of this question.';
  for (const c of s.controls) {
    const v = raw[c.id];
    if (c.kind === 'checkbox') { if (typeof v !== 'boolean' || (c.required && !v)) return 'Confirm the required checkbox.'; continue; }
    const finite = ['select','radio','checkbox-group'].includes(c.kind);
    if (c.multiple && c.kind === 'select' || c.kind === 'checkbox-group') {
      if (!Array.isArray(v) || !v.every(x=>typeof x === 'string') || new Set(v).size !== v.length
        || (c.required && !v.length) || v.some(x=>!c.choices.some(o=>o.id === x && !o.disabled&&!o.hidden)) || c.kind==='checkbox-group'&&c.choices.some(o=>o.required&&!o.disabled&&!o.hidden&&!v.includes(o.id))) return 'Choose from the original available options.';
      continue;
    }
    if (typeof v !== 'string' || v.length > 4000 || (c.required && !v.trim())) return 'Provide a complete answer.';
    if (finite) { if (v && !c.choices.some(o=>o.id === v && !o.disabled&&!o.hidden && !(c.kind==='select'&&c.required&&o.placeholder))) return 'Choose from the original available options.'; continue; }
    if (!v) continue;
    const issue=questionValueIssue(c,v);
    if(issue)return issue;

  }
  if(Object.values(raw).every(value=>typeof value==='string'&&!value.trim()))return 'Provide an answer before saving.';
  return null;
}

export function questionAnswerText(s: QuestionSnapshot, response: QuestionResponse): string {
  return s.controls.map(c => {
    const v=response[c.id];
    const label=(id:string)=>c.choices.find(o=>o.id === id)?.label ?? id;
    const value=Array.isArray(v)?v.length?v.map(label).join('; '):'No options selected':typeof v === 'boolean'?String(v):['radio','select'].includes(c.kind)?label(v):v;
    return s.controls.length>1?`${c.label}: ${value}`:value;
  }).join('\n');
}

/** Choice sets have source order, not click order; object insertion order is
 * not a different candidate answer. Call only after schema validation. */
export function canonicalQuestionResponse(s:QuestionSnapshot,response:QuestionResponse):QuestionResponse {
  return Object.fromEntries(s.controls.map(c=>[c.id,Array.isArray(response[c.id])?c.choices.filter(o=>(response[c.id] as string[]).includes(o.id)).map(o=>o.id):response[c.id]]));
}
