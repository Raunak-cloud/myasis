import { toolInputIssue } from './agent/tool-input.js';

export interface CurrentOccupationIntent {
  scope: 'bounded' | 'open' | 'uncertain';
  source: 'current-standing-instructions' | 'current-target-role' | 'current-search-preferences' | 'none';
  quote: string;
  requestedWork: string;
}
export interface PrimaryWorkOutput {
  output: string;
  employerQuote: string;
  relationship: 'requested-work' | 'capability-only' | 'outside-intent' | 'uncertain';
  mapping: string;
}
/** Agent-authored matching evidence, retained for audit and application context.
 * Historical records may lack provenance; only new fit replies must satisfy
 * the current schema. Existing saved outcomes are never rewritten. */
export interface RoleFitCheck {
  alignment: 'aligned' | 'mismatch' | 'uncertain';
  employerEvidence: string;
  candidateEvidence: string;
  explanation: string;
  currentIntent?: CurrentOccupationIntent;
  primaryOutputs?: PrimaryWorkOutput[];
}

export const ROLE_FIT_SCHEMA = { type: 'object', additionalProperties: false, properties: {
  currentIntent: { type: 'object', additionalProperties: false, properties: {
    scope: { type: 'string', enum: ['bounded', 'open', 'uncertain'], description: 'Interpret current occupation preferences; requested job functions constrain scope, while equivalent titles remain allowed.' },
    source: { type: 'string', enum: ['current-standing-instructions', 'current-target-role', 'current-search-preferences', 'none'], description: 'The current source defining intended work. Never attribute historical CV or cover-letter interest to a current source.' },
    quote: { type: 'string', maxLength: 2000, description: 'Copy an exact passage from that current source, preserving defining qualifiers and exceptions. Empty only for source=none.' },
    requestedWork: { type: 'string', minLength: 1, maxLength: 1500, description: 'The positively requested function and its defining qualifiers, or an explicit statement that current preferences do not bound occupation.' },
  }, required: ['scope', 'source', 'quote', 'requestedWork'] },
  primaryOutputs: { type: 'array', minItems: 0, maxItems: 3, description: 'Leave empty when supplied employer evidence does not establish any actual primary duties; do not invent a quote. An aligned assessment needs at least one evidenced output.', items: { type: 'object', additionalProperties: false, properties: {
    output: { type: 'string', minLength: 1, maxLength: 1000, description: 'A dominant employer deliverable or responsibility, not an incidental shared tool or transferable skill.' },
    employerQuote: { type: 'string', minLength: 1, maxLength: 2000, description: 'Exact passage from the supplied job description/summary establishing this primary output.' },
    relationship: { type: 'string', enum: ['requested-work', 'capability-only', 'outside-intent', 'uncertain'] },
    mapping: { type: 'string', minLength: 1, maxLength: 1500, description: 'Explain how the primary output itself serves currently requested work, or why it is only transferable capability/different work. Capability alone cannot broaden bounded current intent.' },
  }, required: ['output', 'employerQuote', 'relationship', 'mapping'] } },
  alignment: { type: 'string', enum: ['aligned', 'mismatch', 'uncertain'] },
  employerEvidence: { type: 'string' }, candidateEvidence: { type: 'string', description: 'Separate evidence of capability from CV, documents and saved candidate facts; this does not grant occupation permission.' }, explanation: { type: 'string' },
}, required: ['currentIntent', 'primaryOutputs', 'alignment', 'employerEvidence', 'candidateEvidence', 'explanation'] };

export interface FitProvenanceSources {
  'current-standing-instructions': string;
  'current-target-role': string;
  'current-search-preferences': string;
  employerText: string;
}
const normal = (text: string) => text.replace(/\s+/g, ' ').trim();
/** Source attribution and shape only. No occupation classifier, semantic
 * decision override or quotation rule on the older explanatory diagnostics. */
export function roleFitProvenanceError(value: unknown, sources?: FitProvenanceSources): string | null {
  const issue = toolInputIssue(value, ROLE_FIT_SCHEMA);
  if (issue) return `roleFitCheck ${issue}`;
  const role = value as RoleFitCheck & { currentIntent: CurrentOccupationIntent; primaryOutputs: PrimaryWorkOutput[] };
  if (role.alignment === 'aligned' && !role.primaryOutputs.length) return 'roleFitCheck aligned requires at least one evidenced primary output; use uncertain when employer duties are unavailable';
  const intent = role.currentIntent;
  if (intent.source === 'none') {
    if (intent.quote.trim() || intent.scope === 'bounded') return 'roleFitCheck.currentIntent source=none needs an empty quote and cannot claim a bounded current occupation';
  } else if (!intent.quote.trim()) return 'roleFitCheck.currentIntent.quote must identify the selected current source';
  for (let index = 0; index < role.primaryOutputs.length; index++) {
    if (!normal(role.primaryOutputs[index].employerQuote)) return `roleFitCheck.primaryOutputs[${index}].employerQuote must cite nonempty employer evidence`;
  }
  if (!sources) return null;
  if (intent.source === 'none' && [sources['current-standing-instructions'], sources['current-target-role'], sources['current-search-preferences']].some(text => normal(text))) {
    return 'roleFitCheck.currentIntent must cite an available current preference source; use open scope when that source does not bound occupation rather than attributing no current source';
  }
  if (intent.source !== 'none' && !normal(sources[intent.source]).includes(normal(intent.quote))) {
    return 'roleFitCheck.currentIntent.quote is not a passage from its selected current preference source; do not attribute CV or cover-letter wording to current settings';
  }
  for (let index = 0; index < role.primaryOutputs.length; index++) {
    if (!normal(sources.employerText).includes(normal(role.primaryOutputs[index].employerQuote))) return `roleFitCheck.primaryOutputs[${index}].employerQuote is not a passage from the supplied employer description/summary`;
  }
  return null;
}
