import { createHash } from 'node:crypto';
import { ROLE_FIT_SCHEMA, type FitProvenanceSources } from './role-fit.js';
import { toolInputIssue } from './agent/tool-input.js';

type PreferenceSource = Exclude<keyof FitProvenanceSources, 'employerText'>;
type PassageSource = PreferenceSource | 'employerText';
export interface FitSourcePassage { id?: string; text: string }
interface BoundPassage extends FitSourcePassage { id: string; source: PassageSource }
export interface FitProvenanceCatalog {
  preferences: Record<PreferenceSource, FitSourcePassage[]>;
  employer: FitSourcePassage[];
  /** Request-local lookup. IDs never resolve from a global or historical map. */
  byId: ReadonlyMap<string, BoundPassage>;
}
const preferenceSources: PreferenceSource[] = ['current-standing-instructions', 'current-target-role', 'current-search-preferences'];

/** Exact slices only. Prefer paragraph boundaries, then whitespace; do not
 * rewrite Unicode, punctuation, HTML or qualifications inside the source. */
function boundedPassages(text: string): string[] {
  const points = [...text], result: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = Math.min(start + 2000, points.length);
    if (end < points.length) {
      const minimum = start + 800;
      let boundary = -1;
      for (let i = end - 1; i >= minimum; i--) if (points[i] === '\n') { boundary = i + 1; break; }
      if (boundary < 0) for (let i = end - 1; i >= minimum; i--) if (/\s/u.test(points[i])) { boundary = i + 1; break; }
      if (boundary > start) end = boundary;
    }
    result.push(points.slice(start, end).join(''));
    start = end;
  }
  return result;
}

/** The binding is the current listing/owner context; the digest also binds the
 * complete source, so an edited source cannot reuse one unchanged old span ID. */
export function fitProvenanceCatalog(sources: FitProvenanceSources, employerSpans: readonly string[], binding: string): FitProvenanceCatalog {
  const byId = new Map<string, BoundPassage>();
  function passages(source: PassageSource, spans: readonly string[]): FitSourcePassage[] {
    const digest = createHash('sha256').update(JSON.stringify(['fit-source-v1', binding, source, sources[source]])).digest('hex');
    return spans.flatMap(boundedPassages).map((text, index) => {
      // Whitespace remains in the supplied evidence, but cannot be cited as a duty.
      if (!text.trim()) return { text };
      const id = `p_${digest}_${index}`;
      byId.set(id, { id, source, text });
      return { id, text };
    });
  }
  for (const text of employerSpans) if (!sources.employerText.includes(text)) throw new Error('Fit passage must be an exact supplied employer source span.');
  return { preferences: Object.fromEntries(preferenceSources.map(source => [source, passages(source, [sources[source]])])) as FitProvenanceCatalog['preferences'],
    employer: passages('employerText', employerSpans), byId };
}

/** Only the transport differs. Persisted RoleFitCheck keeps its original exact
 * quote fields and continues through the same v25 provenance validator. */
export function fitProvenanceWireSchema(catalog: FitProvenanceCatalog): Record<string, unknown> {
  const schema = structuredClone(ROLE_FIT_SCHEMA) as unknown as Record<string, any>;
  const intent = schema.properties.currentIntent;
  delete intent.properties.quote;
  intent.properties.passageId = { type: 'string', enum: ['', ...preferenceSources.flatMap(source => catalog.preferences[source].flatMap(p => p.id ? [p.id] : []))],
    description: 'Select the supplied passage ID belonging to source. Do not transcribe or invent a quote. Empty only for source=none when all current sources are empty.' };
  intent.required = intent.required.map((key: string) => key === 'quote' ? 'passageId' : key);
  const outputs = schema.properties.primaryOutputs, item = outputs.items;
  delete item.properties.employerQuote;
  const employerIds = catalog.employer.flatMap(p => p.id ? [p.id] : []);
  item.properties.employerPassageId = { type: 'string', enum: employerIds.length ? employerIds : [''],
    description: 'Select the supplied employer passage establishing this primary output. Never return copied/paraphrased quotation text or a candidate/current-preference passage ID.' };
  item.required = item.required.map((key: string) => key === 'employerQuote' ? 'employerPassageId' : key);
  if (!employerIds.length) outputs.maxItems = 0;
  return schema;
}

export function resolveFitProvenanceWire(value: unknown, catalog: FitProvenanceCatalog): { value?: unknown; error: string | null } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'response must be an object' };
  const raw = value as Record<string, unknown>;
  const issue = toolInputIssue(raw.roleFitCheck, fitProvenanceWireSchema(catalog));
  if (issue) return { error: `roleFitCheck ${issue}` };
  const role = raw.roleFitCheck as Record<string, any>;
  const { passageId, ...intent } = role.currentIntent;
  const intentPassage = catalog.byId.get(passageId);
  if (intent.source === 'none' ? passageId !== '' : !intentPassage || intentPassage.source !== intent.source) {
    return { error: 'roleFitCheck.currentIntent.passageId must reference its selected current source in this request' };
  }
  const primaryOutputs: Record<string, unknown>[] = [];
  for (const [index, output] of role.primaryOutputs.entries()) {
    const { employerPassageId, ...fields } = output;
    const passage = catalog.byId.get(employerPassageId);
    if (!passage || passage.source !== 'employerText') return { error: `roleFitCheck.primaryOutputs[${index}].employerPassageId must reference supplied employer evidence in this request` };
    primaryOutputs.push({ ...fields, employerQuote: passage.text });
  }
  return { error: null, value: { ...raw, roleFitCheck: { ...role, currentIntent: { ...intent, quote: intentPassage?.text ?? '' }, primaryOutputs } } };
}
