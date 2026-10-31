import {createHash,createHmac,randomBytes,randomInt,timingSafeEqual,scryptSync} from 'node:crypto';
import {candidateText,pdf,detailPages,renderPage} from './fixtures.mjs';
export const formCatalog=[
 {key:'enterprise',name:'Enterprise application',company:'Fictional Meridian Labs',pages:15,description:'Repeated employment sections, dependent regions, searchable dropdowns, original-file uploads, delayed saves and late validation.',account:false},
 {key:'account',name:'Candidate account and Gmail',company:'Fictional Northstar Group',pages:15,description:'Create a test account, verify a real emailed code, resume after session expiry, and complete a 15-page application.',account:true},
 {key:'embedded',name:'Embedded employer portal',company:'Fictional Harbor Services',pages:15,description:'Nested questionnaires, shadow controls, repeated project names, conditional answers, asynchronous uploads and recovery.',account:false},
];
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const f=(name,label,extra={})=>({name,label,...extra});
export function materials(email){
 const text=candidateText.replaceAll('alex.morgan@example.invalid',email)+'\nUse '+email+' for this synthetic application only. For a new fictional account, generate a unique test-only password. No real employer is involved.';
 return {text,profile:{name:'Alex Morgan',email,phone:'0412345678',nationality:'Australian',workRights:'Australian citizen',expectedSalary:'AUD 95000 annual base excluding super',noticePeriod:'14 days',willingToRelocate:false,securityClearance:'None held',skills:['TypeScript','React','SQL'],excludedDomains:[],experienceSummary:text},files:{
  cv:{name:'Alex_Morgan_Test_CV.pdf',bytes:pdf(text)},qualification:{name:'Fictional_Degree.pdf',bytes:pdf('FICTIONAL TEST CERTIFICATE\nAlex Morgan\nBachelor of Information Technology\nFictional Technical College\nCompleted November 2020\nNot a real credential.')},
  sampleA:{name:'Web_App_Sample.txt',bytes:Buffer.from('FICTIONAL WORK SAMPLE: React and TypeScript web application. Author Alex Morgan.')},sampleB:{name:'SQL_Sample.txt',bytes:Buffer.from('FICTIONAL WORK SAMPLE: SQL reporting demo. Author Alex Morgan.')},
 }};
}
export function pagesFor(key,email){
 const contact={title:'Contact details',instructions:'Phone country code is separate. Enter the national mobile without its leading zero. Leave unsupplied optional links blank.',groups:[{legend:'Applicant',fields:[f('fullName','Full name'),f('email','Email',{type:'email'}),f('dial','Phone country code',{kind:'combo',options:['Australia (+61)','Austria (+43)','New Zealand (+64)']}),f('mobile','Mobile number',{type:'tel'}),f('linkedin','LinkedIn URL',{required:false,type:'url'})]}],expected:{fullName:'Alex Morgan',email,dial:'Australia (+61)',mobile:'412345678',linkedin:''}};
 const history={title:'Employment history',instructions:'Enter both roles. Dates accept YYYY-MM. The current role has no end date.',groups:[{legend:'Current employment',fields:[f('employer1','Employer'),f('role1','Job title'),f('from1','From',{type:'month'}),f('current1','I currently work here',{kind:'checkbox'}),f('to1','To',{type:'month',required:false})]},{legend:'Previous employment',fields:[f('employer2','Employer'),f('role2','Job title'),f('from2','From',{type:'month'}),f('to2','To',{type:'month'})]}],expected:{employer1:'Fictional Aurora Labs',role1:'Full-Stack Developer',from1:'2023-03',current1:'on',to1:'',employer2:'Fictional Atlas Studio',role2:'Software Developer',from2:'2021-02',to2:'2023-02'},transient:true};
 const documents={title:'Resume and supporting documents',instructions:'Attach the supplied resume, qualification certificate and both work samples. Include a concise factual cover letter. Wait until attachment scanning completes.',groups:[{legend:'Documents',fields:[f('resume','Resume',{kind:'file',accept:'.pdf'}),f('qualification','Qualification certificate',{kind:'file',accept:'.pdf'}),f('samples','Work samples',{kind:'file',multiple:true,accept:'.txt,.pdf'})]},{legend:'Cover letter',fields:[f('letter','Write a cover letter',{kind:'editor'})]}],expected:{},uploads:{resume:['cv'],qualification:['qualification'],samples:['sampleA','sampleB']},textChecks:{letter:{minimum:120,words:['TypeScript','React']}}};
 const assessment={title:'Interview and motivation questionnaire',instructions:'Select Normal priority, Australia/Sydney and the available interview date 5 November 2026. Write about accessible TypeScript and React applications.',frame:true,groups:[{legend:'Interview preferences',fields:[f('priority','Application priority',{kind:'combo',options:['Low','Normal','High']}),f('timezone','Interview timezone',{kind:'combo',options:['Australia/Sydney','Australia/Perth','Pacific/Auckland']}),f('interview','Interview date',{type:'date'})]},{legend:'Motivation',fields:[f('motivation','Brief motivation',{kind:'editor'}),f('remote','Can you attend remotely?',{kind:'radio',options:['Yes','No']})]}],expected:{priority:'Normal',timezone:'Australia/Sydney',interview:'2026-11-05',remote:'Yes'},textChecks:{motivation:{minimum:20,words:['accessible','TypeScript','React']}}};
 const details=structuredClone(detailPages);
 details[3].groups[2].legend='Previously employed by '+formCatalog.find(c=>c.key===key).company;
 details[9].uploads={hardQualification:['qualification'],hardSamples:['sampleA','sampleB']};details[9].textChecks={statement:{minimum:20,words:['accessible','TypeScript','React']}};
 const review={title:'Review and submit',instructions:'Review your saved fictional answers and documents. Submit once; processing can take several seconds. A receipt confirms completion.',review:true,groups:[{legend:'Declaration',fields:[f('accuracy','I confirm these fictional answers are accurate',{kind:'checkbox'})]}],expected:{accuracy:'on'}};
 if(key==='embedded'){history.frame=true;history.nested=true;assessment.nested=true;details[2].frame=true;details[2].nested=true;}
 const order=key==='account'?[3,0,1,4,2,6,5,7,8,9]:key==='embedded'?[0,2,1,6,3,7,4,5,8,9]:details.map((_,i)=>i);
 return [contact,history,documents,assessment,...order.map(i=>details[i]),review];
}
function authHtml(heading,content,base,action){
 return `<!doctype html><html lang="en"><meta charset="utf-8"><title>${escape(heading)} | Owtomate test portal</title><style>body{font:16px system-ui;background:#edf3f9;color:#16344c}main{max-width:680px;margin:40px auto;padding:28px;background:white;border:1px solid #aec2d3;border-radius:12px}label{display:block;margin:18px 0}input,button{font:inherit;padding:12px;margin:4px;border:1px solid #879fb4;border-radius:5px}.digits{display:flex;flex-wrap:wrap}.digits input{width:26px}button{cursor:pointer}[role=alert]{color:#9e2222}</style><main><p>OWTOMATE SYNTHETIC TEST - NO REAL EMPLOYER</p><h1>${escape(heading)}</h1>${content}<p role="alert" id="error"></p></main><script>document.querySelector('form').onsubmit=async event=>{event.preventDefault();const button=event.target.querySelector('button');button.disabled=true;try{const response=await fetch(${JSON.stringify(base+'/'+action)},{method:'POST',body:new FormData(event.target)}),result=await response.json();if(!response.ok){document.querySelector('#error').textContent=result.error;return;}location.href=result.next;}finally{button.disabled=false;}};</script></html>`;
}
export class FormLab {
 constructor({key,email,seed,id,secret,state}){
  this.definition=formCatalog.find(c=>c.key===key);if(!this.definition)throw Error('Unknown form.');
  this.key=key;this.email=email;this.seed=seed;this.id=id;this.secret=secret;this.base='/forms/attempts/'+id;this.pages=pagesFor(key,email);this.materials=materials(email);
  this.state=state||{completed:[],saved:{},attempts:{},faults:[],validation:[],events:[],receipt:null,pendingAt:0,lateConsent:false,account:null,verified:false,sessionExpired:false,mailCount:0,codeAttempts:0,codeAccepted:0};
 }
 event(type,detail={}){this.state.events.push({at:new Date().toISOString(),type,...detail});this.state.events=this.state.events.slice(-500);}
 response(status,value,headers={}){return {status,headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(value)};}
 page(body){return {status:200,headers:{'Content-Type':'text/html; charset=utf-8'},body};}
 redirect(path){return {status:302,headers:{Location:this.base+path},body:''};}
 async issueCode(sendCode){
  if(this.state.mailCount>=4)throw Error('This test has reached its verification-email limit. Create a new test attempt.');
  const code=String(randomInt(100000,1000000)),nonce=randomBytes(16).toString('hex');
  this.state.codeHash=createHmac('sha256',this.secret).update(nonce+code).digest('hex');this.state.codeNonce=nonce;this.state.codeExpires=Date.now()+10*60_000;this.state.codeAttempts=0;this.state.mailCount++;this.state.verified=false;
  await sendCode({to:this.email,subject:'[Owtomate synthetic test] '+this.definition.company+' '+this.id+' verification code',text:'Authorized Owtomate test account for '+this.definition.company+'. Test '+this.id+'. Your verification code is: '+code+'. It expires in ten minutes. This is not a real employer account.'});
  this.event('verification_email_sent');
 }
 async handle({method,path,query='',body,contentType},sendCode){
  if(path==='/receipt'){
   if(!this.state.receipt||Date.now()<this.state.pendingAt)return this.response(409,{error:'Still processing. No receipt is available yet.'});
   return this.page(authHtml('Application submitted successfully',`<p>Your fictional application to ${escape(this.definition.company)} was received.</p><p>Receipt: <strong>${escape(this.state.receipt)}</strong></p><p>15 of 15 pages completed. No application was sent to a real employer.</p><form><button>View receipt</button></form>`,this.base,'receipt'));
  }
  if(path==='/receipt-status')return this.response(200,{ready:Boolean(this.state.receipt&&Date.now()>=this.state.pendingAt),next:this.base+'/receipt'});
  let values={};let form;
  if(method==='POST'){
   form=await new Response(body,{headers:{'Content-Type':contentType||'application/octet-stream'}}).formData();
   for(const key of new Set(form.keys())){const items=form.getAll(key);if(items.every(v=>typeof v==='string'))values[key]=items.length>1?items:items[0];}
  }
  if(this.definition.account){
   if(path==='/register'&&method==='GET')return this.page(authHtml(this.state.account?'Sign in to resume your test account':'Create your test candidate account',`<p>Use ${escape(this.email)}. Generate a unique test-only password, at least 12 characters. This account belongs only to this test. A verification code will be sent to your connected mailbox.</p><form>${this.state.account?'':'<label>Full name<input name="name" required autocomplete="name"></label>'}<label>Email address<input name="email" type="email" required autocomplete="username"></label><label>Password<input name="password" type="password" minlength="12" required autocomplete="${this.state.account?'current-password':'new-password'}"></label>${this.state.account?'':'<label>Confirm password<input name="confirm" type="password" minlength="12" required autocomplete="new-password"></label>'}<button>${this.state.account?'Sign in and send code':'Create account and send code'}</button></form>`,this.base,'register'));
   if(path==='/register'&&method==='POST'){
    if(values.email!==this.email)return this.response(422,{error:'Use the connected test mailbox from the fictional candidate evidence.'});
    if(typeof values.password!=='string'||values.password.length<12)return this.response(422,{error:'Use a unique test-only password of at least 12 characters.'});
    if(this.state.account){const actual=scryptSync(values.password,this.state.account.salt,32);if(!timingSafeEqual(actual,Buffer.from(this.state.account.hash,'hex')))return this.response(422,{error:'The test-account password is incorrect. Use the account you created earlier in this attempt.'});}
    else{if(values.name!=='Alex Morgan'||values.confirm!==values.password)return this.response(422,{error:'Use Alex Morgan and matching test passwords.'});const salt=randomBytes(16).toString('hex');this.state.account={salt,hash:scryptSync(values.password,salt,32).toString('hex')};}
    try{await this.issueCode(sendCode);}catch(error){return this.response(503,{error:error.message});}
    return this.response(200,{next:this.base+'/verify'});
   }
   if(path==='/verify'&&method==='GET')return this.page(authHtml('Verify your test account',`<p>Use the newest emailed code for ${escape(this.definition.company)}, test <strong>${escape(this.id)}</strong>. It was sent to ${escape(this.email)} by Owtomate.</p><form><div class="digits">${Array.from({length:6},(_,i)=>`<label>Digit ${i+1}<input aria-label="Verification code digit ${i+1}" name="digit${i+1}" inputmode="numeric" maxlength="1" pattern="[0-9]" required></label>`).join('')}</div><button>Verify code and continue</button></form>`,this.base,'verify'));
   if(path==='/verify'&&method==='POST'){
    if(this.state.verified)return this.response(409,{error:'This verification code was already used.'});
    if(!this.state.codeHash||Date.now()>this.state.codeExpires||this.state.codeAttempts>=5)return this.response(410,{error:'The verification code expired or reached its attempt limit. Return to sign in.'});
    this.state.codeAttempts++;const code=Array.from({length:6},(_,i)=>values['digit'+(i+1)]||'').join('');const hash=createHmac('sha256',this.secret).update(this.state.codeNonce+code).digest('hex');
    if(!timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(this.state.codeHash,'hex')))return this.response(422,{error:'This code does not match this test attempt. Read the exact newest verification email.'});
    this.state.verified=true;this.state.codeHash=null;this.state.codeAccepted++;this.event('account_verified');return this.response(200,{next:this.base+'/page/'+(this.state.completed.length+1)});
   }
   if(!this.state.verified)return this.redirect('/register');
  }
  const match=path.match(/^\/(page|frame|save)\/(\d+)$/);if(!match)return this.redirect('/page/1');
  const number=Number(match[2]),index=number-1,spec=this.pages[index];if(!spec)return this.response(404,{error:'Unknown page.'});
  if(this.state.completed.length<index)return this.response(409,{error:'Complete and save the earlier pages first.'});
  if(method==='GET'){
   if(this.definition.account&&number===3&&!this.state.sessionExpired){this.state.sessionExpired=true;this.state.verified=false;this.event('session_expired');return this.redirect('/register');}
   if(match[1]==='frame'&&spec.nested&&!query.includes('inner=1'))return this.page(`<!doctype html><html lang="en"><title>Assessment container</title><iframe title="Inner employer questions" src="${this.base}/frame/${number}?inner=1" style="width:100%;height:1500px;border:0"></iframe><script>addEventListener('message',event=>{if(event.data?.type==='hard-compliance-saved')parent.postMessage(event.data,'*');});</script></html>`);
   let current=spec;
   if(spec.review&&this.state.lateConsent)current={...spec,groups:[...spec.groups,{legend:'Additional processing consent',fields:[f('processing','I consent to this fictional test submission',{kind:'checkbox'})]}]};
   const review=spec.review?`<details open><summary>Saved application (${this.state.completed.length}/14 sections)</summary>${Object.entries(this.state.saved).map(([page,saved])=>`<h2>${escape(this.pages[Number(page)-1].title)}</h2><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(JSON.stringify({answers:saved.values,uploads:Object.fromEntries(Object.entries(saved.uploads).map(([key,items])=>[key,items.map(file=>file.name)]))},null,2))}</pre>`).join('')}</details>`:'';
   this.event('page_view',{page:number});return this.page(renderPage(current,this.seed,index,{embedded:match[1]==='frame',base:this.base,company:this.definition.company,review}));
  }
  if(method!=='POST'||match[1]!=='save')return this.response(405,{error:'Unsupported request.'});
  this.state.attempts[number]=(this.state.attempts[number]||0)+1;
  await new Promise(done=>setTimeout(done,200+(this.seed+number*917)%900));
  const checks=[],errors=[],uploads={};
  for(const [key,expected]of Object.entries(spec.expected)){
   const actual=values[key]??'',passed=Array.isArray(expected)?JSON.stringify((Array.isArray(actual)?actual:actual?[actual]:[]).slice().sort())===JSON.stringify(expected.slice().sort()):actual===expected;
   checks.push({key,passed});if(!passed)errors.push('Check '+(spec.groups.flatMap(g=>g.fields).find(field=>field.name===key)?.label||key)+' in its named section against your fictional candidate evidence.');
  }
  for(const [key,rule]of Object.entries(spec.textChecks||{})){const text=String(values[key]||''),passed=text.length>=rule.minimum&&rule.words.every(word=>text.toLowerCase().includes(word.toLowerCase()));checks.push({key,passed});if(!passed)errors.push('Complete '+key+' using your supplied fictional evidence.');}
  for(const [key,ids]of Object.entries(spec.uploads||{})){
   const files=form.getAll(key).filter(file=>typeof file!=='string'&&file.size);uploads[key]=await Promise.all(files.map(async file=>({name:file.name,bytes:file.size,sha256:sha(Buffer.from(await file.arrayBuffer()))})));
   const passed=JSON.stringify(uploads[key].map(file=>file.sha256).sort())===JSON.stringify(ids.map(id=>sha(this.materials.files[id].bytes)).sort());checks.push({key:key+'-original-bytes',passed});if(!passed)errors.push('Attach the original supplied '+key+' files, including every requested work sample.');
  }
  if(spec.review&&values.processing!=='on'){
   this.state.lateConsent=true;this.event('late_validation');return this.response(422,{error:'An additional fictional processing consent is now required. Reload this review page to see it; all saved answers are retained.',reload:true});
  }
  if(errors.length){this.state.validation.push({page:number,errors});this.event('validation_error',{page:number,errors});return this.response(422,{error:errors.join(' ')});}
  if(spec.transient&&!this.state.faults.includes(number)){this.state.faults.push(number);this.event('temporary_service_failure',{page:number});return this.response(503,{error:'Temporary service interruption. Your entered values and selected files are retained. Retry Save and continue.'});}
  if(this.state.receipt)return this.response(409,{error:'This test application has already been submitted. Do not submit again.'});
  this.state.saved[number]={values,uploads,checks};if(!this.state.completed.includes(number))this.state.completed.push(number);this.event('page_saved',{page:number});
  if(spec.review){this.state.receipt='OWT-TEST-'+this.id.slice(0,8).toUpperCase();this.state.pendingAt=Date.now()+2000+(this.seed%1600);this.event('submission_accepted');return this.response(200,{next:this.base+'/processing'});}
  return this.response(200,{ok:true,next:this.base+'/page/'+(number+1)});
 }
 async request(request,sendCode){
  if(request.path==='/processing')return this.page(`<!doctype html><html lang="en"><title>Processing test application</title><main><h1>Please wait...</h1><p>This is not a receipt. Your test application is processing.</p></main><script>const check=async()=>{const response=await fetch(${JSON.stringify(this.base+'/receipt-status')}),data=await response.json();if(data.ready)location.href=data.next;else setTimeout(check,650);};check();</script></html>`);
  return this.handle(request,sendCode);
 }
 summary(){const checks=Object.values(this.state.saved).flatMap(saved=>saved.checks);return {pagesCompleted:this.state.completed.length,totalPages:15,checksPassed:checks.filter(check=>check.passed).length,checksSaved:checks.length,submitted:Boolean(this.state.receipt),receipt:this.state.receipt,accountVerified:this.state.verified,verificationCodesAccepted:this.state.codeAccepted,emailsSent:this.state.mailCount,recoveredServiceFailures:this.state.faults.filter(page=>this.state.completed.includes(page)).length,validationErrors:this.state.validation,events:this.state.events.slice(-30)};}
}
