import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {chromium} from 'patchright';
import type {CandidateProfile} from '../types.js';
import type {ToolContext} from './context.js';
import {withApplicationModel} from '../application-model.js';
import {doCompleteAuthentication,doRecordAuthenticationResult} from './authentication.js';
import {pendingCredential,storedCredential} from '../site-credentials.js';
import {observe} from './observe.js';

// Fictional native-browser registration only: no model, mailbox, employer or send.
test('inline activation evidence and a restarted tool context preserve the registered password through verified sign-in', {timeout:30_000}, async()=>{
 const directory=mkdtempSync(join(tmpdir(),'owtomate-registration-recovery-'));
 const previousSecret=process.env.SITE_AUTH_SECRET;
 process.env.SITE_AUTH_SECRET='synthetic-registration-recovery-secret';
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:process.platform==='win32'?{channel:'chrome'}:{})});
 const page=await browser.newPage();
 const profile={name:'Synthetic Applicant',email:'synthetic.applicant@fixture.invalid',phone:'0400000000'} as CandidateProfile;
 const company='Fictional Community Services';
 const form='<main><h1>Candidate account</h1><label>Email address<input id="email" type="email"></label><label>Password<input id="password" type="password"></label><button id="continue">Continue</button></main>';
 const pendingMessage=`There is already an account with the email ${profile.email}, but it is not activated yet. A link to activate your account has been sent to ${profile.email}. If you cannot see it, please check your spam folder or add activation@fixture.invalid to your "safe list" or address book. To send the activation link to your email again, click the Resend button.`;
 const activatedMessage=`Your account for ${profile.email} is now activated. Sign in to continue your application.`;
 const inputs={targets:[{selector:'#email'},{selector:'#password'}]};
 await page.route('**/*',route=>new URL(route.request().url()).hostname.endsWith('.invalid')
  ?route.fulfill({contentType:'text/html',body:form}):route.abort());
 try{await withApplicationModel({DATA_DIR:directory},async()=>{
  await page.goto('https://shared-careers.fixture.invalid/register');
  const context=async()=>({page,profile,job:{id:'synthetic-registration',title:'Data Analyst',company},observation:await observe(page),actions:[],captured:[],log:()=>{}} as unknown as ToolContext);
  let ctx=await context();
  const prepared=await doCompleteAuthentication(ctx,{purpose:'create_account',password_rules:{min_length:12,max_length:16,symbols:'required'},...inputs});
  assert.equal(prepared.kind==='ok'&&prepared.disposition,'completed');
  const originalPassword=await page.locator('#password').inputValue();
  assert.ok(originalPassword.length>=12&&originalPassword.length<=16);
  const originalRecipe=pendingCredential(page.url(),profile.email,company,'create_account');
  assert.equal(originalRecipe?.phase,'prepared');
  assert.equal(storedCredential(page.url(),profile.email),null,'filling registration fields is not account acceptance');

  // Inline elements deliberately abut punctuation, as real activation dialogs do.
  await page.setContent(`<main><h1>Account Already Exists</h1><section role="alert"><p>There is already an account with the email <strong>${profile.email}</strong>, but it is not activated yet.</p><p>A link to activate your account has been sent to <a href="mailto:${profile.email}">${profile.email}</a>. If you cannot see it, please check your spam folder or add <span>activation@fixture.invalid</span> to your "safe list" or address book.</p><p>To send the activation link to your email again, click the Resend button.</p></section><button>Resend</button></main>`);
  const pending=await doRecordAuthenticationResult(ctx,{purpose:'create_account',outcome:'needs_verification',evidence:pendingMessage});
  assert.equal(pending.kind==='ok'&&pending.disposition,'reobserve','the complete current employer copy must establish pending verification');
  assert.equal(pendingCredential(page.url(),profile.email,company,'create_account')?.phase,'needs_verification');
  assert.equal(storedCredential(page.url(),profile.email),null);
  assert.ok(!ctx.actions.some(action=>action.kind==='account-created'),'activation pending cannot claim account creation success');

  // The original applying context and its in-memory credential map are gone.
  await page.setContent(form);ctx=await context();
  assert.equal(ctx.pendingCredentials,undefined);
  const premature=await doCompleteAuthentication(ctx,{purpose:'sign_in',...inputs});
  assert.equal(premature.kind==='ok'&&premature.disposition,'reobserve');
  assert.match(premature.kind==='ok'?premature.message:'',/saved pending registration/i);
  assert.equal(await page.locator('#password').inputValue(),'','pending data cannot authorize a guessed login');
  await doCompleteAuthentication(ctx,{purpose:'create_account',password_rules:{min_length:20,max_length:24,symbols:'not_allowed'},...inputs});
  assert.equal(await page.locator('#password').inputValue(),originalPassword,'reopening registration preserves the password already awaiting activation');
  const recoveredRecipe=pendingCredential(page.url(),profile.email,company,'create_account');
  assert.deepEqual(recoveredRecipe, {...originalRecipe,phase:'needs_verification',at:recoveredRecipe?.at},'restart and a different proposed rule set must not replace the saved recipe');

  // A narrative or user-editable echo cannot promote the durable proposal.
  await page.setContent(`<main><p>Activation is still pending. Check your email.</p><label>Extra notes<textarea>${activatedMessage}</textarea></label><input value="${activatedMessage}" aria-label="Candidate notes"></main>`);
  ctx=await context();
  const fabricated=await doRecordAuthenticationResult(ctx,{purpose:'create_account',outcome:'accepted',evidence:activatedMessage});
  assert.equal(fabricated.kind==='ok'&&fabricated.disposition,'uncertain');
  assert.equal(storedCredential(page.url(),profile.email),null,'candidate-authored or fabricated success cannot become a verified password');
  assert.equal(pendingCredential(page.url(),profile.email,company,'create_account')?.phase,'needs_verification');
  assert.equal(ctx.actions.length,0);

  await page.setContent(`<main><section role="status"><p>Your account for <strong>${profile.email}</strong> is now activated. Sign in to continue your application.</p></section></main>`);
  ctx=await context();
  const accepted=await doRecordAuthenticationResult(ctx,{purpose:'create_account',outcome:'accepted',evidence:activatedMessage});
  assert.equal(accepted.kind==='ok'&&accepted.disposition,undefined);
  assert.deepEqual(storedCredential(page.url(),profile.email)?.rules,originalRecipe?.rules,'current activation evidence promotes the exact durable recipe after restart');
  assert.equal(pendingCredential(page.url(),profile.email,company,'create_account'),null);
  assert.equal(ctx.actions.filter(action=>action.kind==='account-created').length,1);
  assert.ok(!ctx.actions.some(action=>action.kind==='signed-in'),'activation is not an authenticated session');

  await page.setContent(form);ctx=await context();
  const signedInFields=await doCompleteAuthentication(ctx,{purpose:'sign_in',...inputs});
  assert.equal(await page.locator('#email').inputValue(),profile.email);
  assert.equal(await page.locator('#password').inputValue(),originalPassword,'the later sign-in uses the exact password from the initial registration');
  assert.ok(!JSON.stringify(signedInFields).includes(originalPassword),'private values stay out of tool output');
  assert.ok(!ctx.actions.some(action=>action.kind==='signed-in'),'filled fields alone are not successful authentication');
  await page.locator('#continue').evaluate(button=>button.addEventListener('click',()=>{document.querySelector('main')!.innerHTML='<p role="status">You are signed in. Continue your saved application.</p>';}));
  await page.locator('#continue').click();
  await doRecordAuthenticationResult(ctx,{purpose:'sign_in',outcome:'accepted',evidence:'You are signed in. Continue your saved application.'});
  assert.equal(ctx.actions.filter(action=>action.kind==='signed-in').length,1);
  const metadata=['pending-site-credentials.json','site-credentials.json'].map(file=>readFileSync(join(directory,file),'utf8')).join('\n');
  assert.ok(!metadata.includes(originalPassword),'durable metadata stores a recipe, never password bytes');
 });}finally{
  await browser.close();
  if(previousSecret===undefined)delete process.env.SITE_AUTH_SECRET;else process.env.SITE_AUTH_SECRET=previousSecret;
  const target=resolve(directory);assert.ok(target.startsWith(resolve(tmpdir())+sep));rmSync(target,{recursive:true,force:true});
 }
});
