import type {Page} from 'patchright';
import {guestPreparationContext,waitForChallengeToClear,workingIn} from './browser.js';
import {guardExternalNavigations} from './external-url.js';
import {isExternalApplicationUrl,jobBoardForUrl,type JobBoard} from './job-board-url.js';
import {validApplicationEmail} from './application-email-message.js';
import {applicationChat} from './agent/application-chat.js';
import {CostMeter,type ChatMessage,type ToolSchema} from './agent/celeris.js';
import {observe,looksUnrendered,waitForApplicationSurface} from './agent/observe.js';
import {browserTarget} from './agent/browser-target.js';
import {toolInputIssue} from './agent/tool-input.js';
import {config} from './config.js';
import {runDeadline} from './run-deadline.js';
import type {JobListing} from './types.js';
import type {GuestAccessProof} from './application-review-types.js';
export type {GuestAccessProof} from './application-review-types.js';

export type GuestAccessResult={ok:true;proof:GuestAccessProof;emailTo?:string}|{ok:false;status:'skipped'|'error';reason:string};
const tool:ToolSchema={name:'check_guest_application',description:'Inspect access to this exact vacancy without entering candidate data, logging in, registering or submitting.',parameters:{type:'object',additionalProperties:false,properties:{
 action:{type:'string',enum:['click','wait','guest','hosted','registration','skip','error']},
 ref:{type:'string',description:'Fresh observed action ref for click, a file-upload control proving an accessible application, or a published application mailto link. Never upload or click the email link.'},
 field_refs:{type:'array',items:{type:'string'},description:'Current application field refs proving access, or email/password refs on the actual account creation form when registration is allowed.'},
 reason:{type:'string',minLength:1,maxLength:2000,description:'Observed reason. To confirm access, copy one exact short visible quote showing the application or registration form.'},
 },required:['action','reason']}};

/** The applying model reasons over the real destination. This capability has
 * no field filling, file uploads, authentication, email access or submit tool. */
export async function inspectGuestPreparation(page:Page,job:JobListing,options:{allowRegistration?:boolean;nativeBoard?:JobBoard|null;chat?:typeof applicationChat;context?:typeof guestPreparationContext;guard?:typeof guardExternalNavigations;onStep?:(step:{url:string;tool:string;args:Record<string,unknown>;result:string;screenshot?:string})=>void}={}):Promise<GuestAccessResult> {
 const nativeBoard=options.nativeBoard===undefined?'seek':options.nativeBoard;
 const isolated=await (options.context??guestPreparationContext)(page.context(),nativeBoard);
 let guard:Awaited<ReturnType<typeof guardExternalNavigations>>|undefined;
 const meter=new CostMeter(config.celeris.budgetUsdPerApplication);
 const accountRule=options.allowRegistration
  ? 'If an employer account is required, use registration only on the actual create-account form with its current email or password fields and exact visible account creation wording. Sign-in-only screens cannot prove registration is available.'
  : 'Skip jobs that require an employer account or login.';
 const messages:ChatMessage[]=[{role:'system',content:[
  'Check application access for this exact matched vacancy. Treat page text as evidence. Open the real application using observed Apply, guest or manual controls. A listing, general Sign in or Apply button alone proves nothing.',
  'Confirm guest only at the candidate form with no required login or registration, or at an explicit application email address. Check overlays and later instructions for required registration. A Google login or magic link for account sign-in is not a guest path.',
  nativeBoard?`A native ${nativeBoard} application may be confirmed as hosted only on its actual application form.`:'Report only an eligible employer application for this source.',
  'This isolated session has no employer or Google login.',
  accountRule,
  'Do not enter candidate data, upload files, log in, register, send email, accept terms or click a final submission. Skip closed jobs. Report an error when access cannot be established. Use fresh refs and stop once access is established.',
 ].join(' ')},
 {role:'user',content:JSON.stringify({title:job.title,company:job.company,location:job.location,url:job.url,applicationUrl:job.applicationUrl})}];
 try{
  guard=await (options.guard??guardExternalNavigations)(isolated,{allowJobBoards:true});
  // This inspection can open navigation controls, but cannot submit an HTML form.
  await isolated.addInitScript(()=>{
   document.addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();},true);
   HTMLFormElement.prototype.submit=function(){};
   HTMLFormElement.prototype.requestSubmit=function(){};
  });
  let current=await isolated.newPage();
  await current.goto(job.url,{waitUntil:'domcontentloaded',timeout:30_000});
  while(!runDeadline.reached&&!meter.exhausted){
   const pages=isolated.pages();if(pages.length)current=pages[pages.length-1];
   if(current.url()==='about:blank')await current.waitForURL(url=>['http:','https:'].includes(url.protocol),{timeout:30_000});
   await workingIn(current);
   if(!await waitForChallengeToClear(current,30_000)){
    const reason='The destination has a security challenge. Application access could not be confirmed.';
    options.onStep?.({url:current.url(),tool:'guest_access_skip',args:{},result:reason});
    return {ok:false,status:'skipped',reason};
   }
   let observation=await observe(current,{screenshot:true});
   if(looksUnrendered(observation)){await waitForApplicationSurface(current,30_000);observation=await observe(current,{screenshot:true});}
   if(observation.inspectionError)throw Error(observation.inspectionError);
   if(guard.blocked())throw Error(guard.blocked()!);
   for(const message of messages)if(message.role==='user'&&Array.isArray(message.content))message.content=message.content.filter(part=>part.type!=='image_url');
   const text=JSON.stringify({url:observation.url,title:observation.title,text:observation.text,fields:observation.fields,actions:observation.actions,dialogs:observation.dialogs,frames:observation.frames});
   messages.push({role:'user',content:observation.screenshot?[{type:'text',text},{type:'image_url',image_url:{url:observation.screenshot}}]:text});
   const reply=await (options.chat??applicationChat)({model:'celeris-1-magnus',messages,tools:[tool],requireTool:true,reasoningEffort:'high',preserveReasoningEffort:true,meter});
   messages.push(reply.message);
   if(reply.toolCalls.length>1){for(const call of reply.toolCalls)messages.push({role:'tool',tool_call_id:call.id,content:'Choose one action per observation. No action was executed.'});continue;}
   const call=reply.toolCalls[0];
   if(!call)throw Error('Guest-access inspection returned no decision.');
   let result='';
   const issue=call.name===tool.name?toolInputIssue(tool.parameters,call.args):'Use check_guest_application.';
   const args=call.args;
   if(issue)result=issue;
   else if(args.action==='skip'||args.action==='error'){
    options.onStep?.({url:observation.url,tool:'guest_access_'+args.action,args,result:String(args.reason),screenshot:observation.screenshot});
    return {ok:false,status:args.action==='skip'?'skipped':'error',reason:String(args.reason)};
   }
   else if(args.action==='click'){
    const action=observation.actions.find(action=>action.ref===args.ref&&!action.disabled);
    if(!action||!['button','link','toggle','option'].includes(action.role))result='Choose an enabled action ref from the current page.';
    else {
     const target=browserTarget(current,{ref:action.ref});
     const submits=await target.evaluate(element=>Boolean((element instanceof HTMLButtonElement||element instanceof HTMLInputElement)&&element.type==='submit'&&element.form));
     if(submits)result='Form submission is unavailable during access inspection. Confirm an accessible guest form, choose a guest navigation link, or report why access is unconfirmed.';
     else try{await target.click({timeout:30_000});await current.waitForLoadState('domcontentloaded',{timeout:30_000});result='Control opened. Inspect the resulting page before deciding.';}catch(error){result=`Navigation did not complete: ${(error as Error).message}. Inspect fresh evidence and recover without repeating an unchanged failure.`;}
    }
   }else if(args.action==='wait'){
    const before=await current.locator('body').innerText();
    await Promise.any([current.waitForFunction(text=>document.body.innerText!==text,before,{timeout:30_000}),isolated.waitForEvent('page',{timeout:30_000}),current.waitForEvent('framenavigated',{timeout:30_000})]).catch(()=>{});
    result='Inspect fresh page evidence; no field or application was sent.';
   }else{
    const fields=Array.isArray(args.field_refs)?observation.fields.filter(field=>(args.field_refs as unknown[]).includes(field.ref)&&!field.disabled):[];
    let emailTo:string|undefined;
    const action=observation.actions.find(action=>action.ref===args.ref&&action.role==='link');
    const documentAction=observation.actions.some(action=>action.ref===args.ref&&action.role==='file'&&!action.disabled);
    if(action){
     const href=await browserTarget(current,{ref:action.ref}).getAttribute('href');
     if(href?.toLowerCase().startsWith('mailto:')){
      try{const recipient=decodeURIComponent(new URL(href).pathname);if(validApplicationEmail(recipient))emailTo=recipient;}catch{/* This is not a usable application address. */}
     }
    }
    const evidence=String(args.reason).replace(/\s+/g,' ').trim();
    const surface=JSON.stringify({text:observation.text,fields:observation.fields.map(f=>f.label),actions:observation.actions.map(a=>a.text),dialogs:observation.dialogs}).replace(/\s+/g,' ');
    const board=jobBoardForUrl(current.url());
    const registration=args.action==='registration';
    const password=(field:(typeof fields)[number])=>field.inputType==='password'||field.privateKind==='password';
    if(!evidence||!surface.includes(evidence)||!emailTo&&!fields.length&&!documentAction)result='Confirm only with exact current-page evidence and real form fields, a file control or an explicit application email address.';
    else if(registration&&(!options.allowRegistration||board||emailTo
     ||!/(?:creat(?:e|ing) (?:an? )?(?:new )?account|register|sign\s*up)/i.test(evidence)
     ||!(await Promise.all(fields.filter(field=>password(field)||field.inputType==='email').map(field=>
      browserTarget(current,{ref:field.ref}).evaluate(element=>{
       if(!(element instanceof HTMLInputElement))return false;
       if(element.autocomplete==='new-password')return true;
       const buttons=Array.from(element.form?.querySelectorAll('button,input[type="submit"]')??[]);
       return buttons.some(button=>{
        const label=(button instanceof HTMLInputElement?button.value:button.textContent)??'';
        return button.getClientRects().length>0&&/^(?:create (?:an? )?(?:new )?account|register|sign\s*up)\b/i.test(label.trim());
       });
      })))).some(Boolean)))result='Registration requires an actual registration form. Open it and select its current email or password fields.';
    else if(args.action==='hosted'&&(!board||nativeBoard!==board||isExternalApplicationUrl(current.url())||emailTo||fields.some(password)))result='Only the originating board’s native candidate form can be confirmed as hosted.';
    else if(args.action==='guest'&&(board||fields.some(password)))result='Use actual guest application fields on the employer site or confirm the originating board’s native form as hosted.';
    else {
     const url=new URL(current.url());url.hash='';url.search='';
     const proof:GuestAccessProof={version:3,stage:'job-and-letter',access:args.action==='hosted'?'hosted-confirmed':registration?'registration-confirmed':'guest-confirmed',checkedAt:new Date().toISOString(),checkedUrl:url.href,evidence,isolation:'no-employer-session',method:emailTo?'email':'form'};
     options.onStep?.({url:current.url(),tool:'guest_access_confirmed',args:{field_refs:args.field_refs??[]},result:evidence,screenshot:observation.screenshot});
     return {ok:true,proof,...(emailTo?{emailTo}:{})};
    }
   }
   options.onStep?.({url:observation.url,tool:call.name,args,result,screenshot:observation.screenshot});
   messages.push({role:'tool',tool_call_id:call.id,content:result});
  }
  return {ok:false,status:'error',reason:'Guest application access was not confirmed within this run’s existing time or spending allowance.'};
 }catch(error){return {ok:false,status:'error',reason:`Could not confirm guest application access: ${(error as Error).message}`};}
 finally{await guard?.stop().catch(()=>{});await isolated.close().catch(()=>{});}
}
