import { createHash } from 'node:crypto';
import { browserTarget, browserTargetProperties } from './browser-target.js';
import { nativeInspect } from './native-browser.js';
import { observe } from './observe.js';
import { ok, type ToolContext, type ToolResult } from './context.js';
import type { ToolSchema } from './celeris.js';
import { rememberedPrivateAuthenticationValues, redactPrivateAuthenticationData } from '../private-auth-fields.js';

export const investigationTool: ToolSchema = {
  name:'investigate_application_state',
  description:'Investigate an unknown outcome with one actual read-only check: fresh whole form, one observed control, or this job\'s owner-scoped attempt history. Returns browser/record evidence, not a success or failure verdict. Retains completed work. Repeated unchanged checks reuse their result; at most four checks per issue. Never clicks, reloads, resets credentials, sends, or changes approval. Act on useful evidence directly; no follow-up report is required.',
  parameters:{type:'object',additionalProperties:false,properties:{
    question:{type:'string',minLength:1,maxLength:1500},check:{type:'string',enum:['form','control','history']},
    uncertainty_id:{type:'string',minLength:1,description:'Optional active uncertainty ID from this shared recovery record. Use it when several issues need separate checks; other applications/accounts are unavailable.'},
    ...browserTargetProperties,
    target_mode:{...browserTargetProperties.target_mode,enum:['ref','selector','locator']},
  },required:['question','check'],anyOf:[
    {properties:{check:{enum:['form','history']}}},
    {properties:{check:{enum:['control']}},anyOf:[{required:['ref']},{required:['selector']},{required:['locator']}]},
  ]},
};

/** Ref IDs, clocks and credential bytes are not new evidence. No site-specific
 * success vocabulary and no model call are used to perform the check. */
function stateKey(ctx: ToolContext): string {
  let url=ctx.observation.url;try {const parsed=new URL(url);url=parsed.origin+parsed.pathname;}catch{/* Unfinished page. */}
  return createHash('sha256').update(JSON.stringify([url,ctx.observation.inspectionError,
    ctx.observation.fields.map(field=>[field.label,field.section,field.kind,field.sensitive||field.privateKind||field.inputType==='password'?'[private]':field.currentValue,field.validationError,field.disabled]),
    ctx.observation.actions.map(action=>[action.text,action.role,action.disabled]),
    (ctx.observation.surfaceText??ctx.observation.text).replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)?\b/gi,'[clock]')])).digest('hex');
}

export async function investigateApplicationState(ctx: ToolContext,args:Record<string,unknown>,history:()=>string):Promise<ToolResult> {
  const record=ctx.recoveryRecord;
  if(!record) return ok('Investigation requires this application\'s owner-scoped recovery record. No browser operation was performed.','invalid-arguments');
  record.assertWriter();
  if(!['form','control','history'].includes(String(args.check)))return ok('Choose form, control or history.','invalid-arguments');
  if(args.uncertainty_id&&!record.snapshot().investigations?.some(issue=>issue.id===args.uncertainty_id&&issue.status==='investigating'))
    return ok('Choose an active uncertainty ID from this application\'s shared record. No other record was read and no check ran.','invalid-arguments');
  if(!record.snapshot().investigations?.some(issue=>issue.status==='investigating'))record.openUncertainty('form','agent-question',String(args.question));
  // Use the observed control identity instead of a rotating ref when available.
  const field=ctx.observation.fields.find(field=>field.ref===args.ref),action=ctx.observation.actions.find(action=>action.ref===args.ref);
  const target=args.check==='control'?field?{label:field.label,section:field.section,identity:field.controlIdentity}:action?{text:action.text,role:action.role,context:action.context}:{selector:args.selector,locator:args.locator,ref:args.ref}:null;
  // History can change independently of the DOM. Read the local source once
  // before caching so a newly recorded outcome is never hidden by an old page.
  let historyEvidence:string|undefined,historyFailed=false;
  if(args.check==='history')try{historyEvidence=history();}catch{historyFailed=true;}
  const sourceKey=args.check==='history'?createHash('sha256').update(historyEvidence??'[history unavailable]').digest('hex'):stateKey(ctx);
  const reservation=record.reserveInvestigationCheck(String(args.check),target,sourceKey,String(args.question),args.uncertainty_id as string|undefined);
  if(!reservation.id)return ok(`UNCHANGED INVESTIGATION CHECK — no browser read or action repeated.\n${reservation.cached}\nThis remains evidence to investigate, not a verdict. Use a different supported check or continue from already verified work.`,'uncertain');
  let result:string;
  try {
    if(args.check==='history'){if(historyFailed)throw Error('History unavailable');result=historyEvidence!;}
    else if(args.check==='control')result=JSON.stringify(await nativeInspect(browserTarget(ctx.page,args)));
    else {
      ctx.observation=await observe(ctx.page);
      result=JSON.stringify({url:ctx.observation.url,title:ctx.observation.title,inspectionError:ctx.observation.inspectionError,
        fields:ctx.observation.fields.map(field=>field.sensitive||field.privateKind||field.inputType==='password'?{...field,currentValue:'[credential withheld]'}:field),
        actions:ctx.observation.actions,text:ctx.observation.text.slice(0,16000)});
    }
    result=redactPrivateAuthenticationData(result,rememberedPrivateAuthenticationValues(ctx.page));
  } catch {
    // Browser errors can echo secrets. A failed read cannot establish whether
    // a previous write succeeded, so retain uncertainty and never replay it.
    result='The investigation read could not finish. No current outcome was established. Keep the prior work and uncertainty; use another available evidence source without repeating a possible send.';
    record.completeInvestigationCheck(reservation.id,result);return ok(result,'uncertain');
  }
  record.completeInvestigationCheck(reservation.id,result);
  return ok(`INVESTIGATION EVIDENCE — read-only; no action replayed and no success/failure inferred.\n${result}\nCompare this evidence with the unknown outcome. Continue directly when it resolves the issue; otherwise choose a different supported check. Candidate confirmation, credential verification and actual receipt requirements still apply.`,'reobserve');
}
