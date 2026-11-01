/** Signals for the single-account coding-repair pilot. Employer text, stack
 * traces, candidate details and credentials never cross this boundary. */
export interface RepairDiagnostic {
  id?: unknown;
  runStartId?: unknown;
  attemptId?: unknown;
  severity?: unknown;
  category?: unknown;
  tool?: unknown;
  message?: unknown;
  failureKind?: unknown;
  sourceSite?: unknown;
  sourceSites?: unknown;
}

export const REPAIR_EDITABLE_FILES = [
  'seek-bot/src/agent/agent-files.ts', 'seek-bot/src/agent/native-browser.ts',
  'seek-bot/src/agent/browser-target.ts', 'seek-bot/src/agent/observe.ts',
] as const;
export interface RepairSourceSite { path: typeof REPAIR_EDITABLE_FILES[number]; function?: string }
function checkedSourceSite(input:unknown):RepairSourceSite|undefined {
  if(!input||typeof input!=='object')return undefined;
  const site=input as Record<string,unknown>;
  if(!(REPAIR_EDITABLE_FILES as readonly unknown[]).includes(site.path))return undefined;
  const name=typeof site.function==='string'&&/^[A-Za-z_$][\w$]{0,79}$/.test(site.function)?site.function:undefined;
  return {path:site.path as RepairSourceSite['path'],...(name?{function:name}:{})};
}
/** Extract only a fixed internal module and identifier; never forward a stack,
 * message, absolute filesystem path, employer text or candidate values. */
export function repairSourceSites(error:unknown):RepairSourceSite[] {
  const sites:RepairSourceSite[]=[];
  if(!(error instanceof Error)||typeof error.stack!=='string')return sites;
  for(const frame of error.stack.split('\n').slice(1,12)){
    const module=frame.replaceAll('\\','/').match(/\/(?:dist|src)\/agent\/(agent-files|native-browser|browser-target|observe)\.[cm]?[jt]s:\d+:\d+\)?$/);
    if(!module)continue;
    const name=frame.match(/^\s*at (?:async )?([A-Za-z_$][\w$]*) \(/)?.[1];
    const site=checkedSourceSite({path:`seek-bot/src/agent/${module[1]}.ts`,function:name});
    if(site&&!sites.some(known=>known.path===site.path&&known.function===site.function))sites.push(site);
    if(sites.length===4)break;
  }
  return sites;
}
export const repairSourceSite=(error:unknown):RepairSourceSite|undefined=>repairSourceSites(error)[0];

export interface RepairIncident {
  runId: string;
  attemptId: string;
  category: 'repeated_tool_failure' | 'tool_execution_failure' | 'application_exception';
  tool?: string;
  code?: 'approved_document_bundle_rejected' | 'target_missing' | 'target_ambiguous' | 'pointer_blocked' | 'outside_viewport' | 'question_capture_rejected' | 'tool_arguments_rejected' | 'runtime_reference_error';
  count: number;
  sourceSite?: RepairSourceSite;
  sourceSites?: RepairSourceSite[];
}

const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
// Tool names come from the trusted dispatcher, not a second drifting catalogue.
const TOOL = /^[a-z][a-z0-9_]{0,63}$/;

/** Only the named active admin account can supply incidents to this pilot.
 * A confirmed dispatcher execution exception can yield immediately. Argument
 * corrections and normal page handoffs remain with the applying agent. Older
 * unclassified warnings retain the two-failure fallback. */
export class RepairPilotDetector {
  private readonly counts = new Map<string, number>();
  private readonly emitted = new Set<string>();
  private readonly seen = new Set<string>();

  private readonly ownerId: string;
  private readonly ownerEmail: string;
  private readonly isActiveAdmin: boolean;
  constructor(ownerId: string, ownerEmail: string, isActiveAdmin: boolean) {
    this.ownerId = ownerId; this.ownerEmail = ownerEmail; this.isActiveAdmin = isActiveAdmin;
  }

  observe(runId: string, input: RepairDiagnostic): RepairIncident | null {
    if (this.ownerId !== '1' || this.ownerEmail.toLowerCase() !== 'raunak.vision@gmail.com' || !this.isActiveAdmin
      || !/^\d+$/.test(runId) || input.runStartId !== runId || typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)
      || typeof input.id !== 'string' || !UUID.test(input.id) || this.seen.has(input.id)) return null;
    this.seen.add(input.id);
    const attemptId = input.attemptId;
    const fatal = input.category === 'application_exception' && input.severity === 'error';
    const tool = typeof input.tool === 'string' && TOOL.test(input.tool) ? input.tool : undefined;
    const execution = input.failureKind === 'execution';
    if(input.failureKind==='arguments'||input.failureKind==='validation'||input.failureKind==='external')return null;
    if (!fatal && !(input.category === 'tool_error' && input.severity === 'warning' && tool)
      && !(input.category==='observation_error'&&execution&&tool)) return null;
    const message = typeof input.message === 'string' ? input.message : '';
    if(/captcha|cloudflare|security verification|(?:OpenRouter|Celeris) (?:40[1239]|429|50[0234])|spending (?:budget|allowance)|browser.*(?:closed|disconnect)|Target.*closed/i.test(message))return null;
    const key = JSON.stringify([runId, attemptId, fatal ? 'application_exception' : tool]);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    if ((!fatal && !execution && count < 2) || this.emitted.has(key)) return null;
    this.emitted.add(key);
    const code = tool === 'create_file' && typeof input.message === 'string'
      && input.message.includes('Generated content must match the candidate-approved cover letter exactly.')
      ? 'approved_document_bundle_rejected' as const
      : /outside of the viewport/i.test(message) ? 'outside_viewport' as const
      : /intercepts pointer events/i.test(message) ? 'pointer_blocked' as const
      : /strict mode violation|resolved to \d+ elements/i.test(message) ? 'target_ambiguous' as const
      : /no longer on the page|waiting for .*exceeded|Timeout .*exceeded/i.test(message) ? 'target_missing' as const
      : /employer quote is not present|complete question labels/i.test(message) ? 'question_capture_rejected' as const
      : /Cannot read propert(?:y|ies).*\b(?:undefined|null)\b|\b\w+ is (?:undefined|not defined)\b/i.test(message) ? 'runtime_reference_error' as const
      : /Invalid tool input/i.test(message) ? 'tool_arguments_rejected' as const : undefined;
    const sourceSite=checkedSourceSite(input.sourceSite);
    const sourceSites=Array.isArray(input.sourceSites)?input.sourceSites.slice(0,4).flatMap(site=>{const checked=checkedSourceSite(site);return checked?[checked]:[];}):[];
    return { runId, attemptId, category: fatal ? 'application_exception' : execution ? 'tool_execution_failure' : 'repeated_tool_failure', ...(tool ? { tool } : {}), ...(code ? { code } : {}), ...(sourceSite?{sourceSite}:{}), ...(sourceSites.length?{sourceSites}:{}), count };
  }
}
