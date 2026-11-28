import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { sealQuestionSnapshot } from '../../seek-bot/src/question-snapshot-node';
import type { QuestionResponse, QuestionControl } from '../../seek-bot/src/question-snapshot';
import { mkdirSync } from 'node:fs';
const { chromium } = createRequire(import.meta.url)('../../seek-bot/node_modules/patchright') as typeof import('../../seek-bot/node_modules/patchright/index.js');

// Bundle only this component and fixture. No dashboard server, database,
// candidate account, run or employer service is started or contacted.
const result = await build({ configFile: false, root: resolve(import.meta.dirname, '..'), plugins: [react()], define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'error', build: { write: false, minify: false, lib: { entry: resolve(import.meta.dirname, 'attention-form.fixture.tsx'), formats: ['iife'], name: 'AttentionFormFixture' } } });
const bundle = (Array.isArray(result) ? result : [result]).flatMap(value => 'output' in value ? value.output : []).find(value => value.type === 'chunk');
const styles=(Array.isArray(result)?result:[result]).flatMap(value=>'output' in value?value.output:[]).filter(value=>value.type==='asset'&&value.fileName.endsWith('.css')).map(value=>value.type==='asset'?String(value.source):'').join('\n');
assert.ok(bundle && bundle.type === 'chunk');
const server = createServer((req, res) => {
  res.setHeader('Content-Type', req.url === '/fixture.js' ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8');
  res.end(req.url === '/fixture.js' ? bundle.code : `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${styles}</style><div id="root"></div><script src="/fixture.js"></script>`);
});
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); assert.ok(address && typeof address !== 'string');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true, ...(process.platform === 'win32' ? { channel: 'chrome' } : { executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome-stable' }) });
  const page = await browser.newPage();
  page.on('pageerror', error => { console.error(error.message); });
  const writes: Array<{ jobId: string; answers: Array<{ questionId: string; revision: string; response: QuestionResponse }> }> = [];
  let mode = 'failed';
  let release: (() => void) | undefined;
  let holdStarted: (() => void) | undefined;
  await page.route('**/api/answers', async route => {
    const body = route.request().postDataJSON(); writes.push(body);
    if (mode === 'held') await new Promise<void>(done => { release = done; holdStarted?.(); });
    await route.fulfill({ status: mode === 'failed' ? 503 : 200, contentType: 'application/json', body: mode === 'failed' ? JSON.stringify({ error: 'SPECIALIST_RECOVERY_SECRET f7 operation_json internal stack trace' }) : JSON.stringify({ ok: true, saved: mode === 'malformed' ? 0 : body.answers.length }) });
  });
  await page.goto(`http://127.0.0.1:${address.port}`);
  const notice = page.getByRole('textbox', { name: 'What is your notice period?', exact: true });
  const reason = page.getByRole('textbox', { name: 'Why do you want this role?', exact: true });
  await notice.fill('Two weeks'); await reason.fill('Relevant work');
  await page.getByRole('button', { name: 'Save answers', exact: true }).click();
  await page.getByText('Could not save the answers. Please try again.', { exact: true }).waitFor();
  assert.ok(!(await page.locator('body').innerText()).includes('SPECIALIST_RECOVERY_SECRET'),'arbitrary server errors never become candidate copy');
  assert.equal(await notice.inputValue(), 'Two weeks'); assert.equal(await reason.inputValue(), 'Relevant work');
  assert.deepEqual(writes[0].answers.map(a=>[a.questionId,a.response.part0]), [['q2_'+ '1'.repeat(64),'Two weeks'],['q2_'+ '2'.repeat(64),'Relevant work']], 'same component IDs in separate questions retain their own typed responses');
  mode = 'malformed';
  await Promise.all([page.waitForResponse(response => new URL(response.url()).pathname === '/api/answers'), page.getByRole('button', { name: 'Save answers', exact: true }).click()]);
  await page.locator('.answer-actions button:not([disabled])').waitFor();
  assert.equal(await page.locator('html').getAttribute('data-saved'), '0');
  assert.equal(await notice.inputValue(), 'Two weeks', 'a malformed success never discards a draft');
  mode = 'held';
  const held = new Promise<void>(done => { holdStarted = done; });
  await page.getByRole('button', { name: 'Save answers', exact: true }).click();
  await held;
  await page.waitForFunction(() => document.querySelector('.answer-actions button')?.textContent === 'Saving…');
  await notice.fill('One month');
  assert.ok(release); release();
  await page.waitForFunction(() => document.documentElement.dataset.saved === '1');
  assert.equal(await notice.inputValue(), 'One month', 'an edit during the request remains unsaved and visible');
  assert.equal(await reason.inputValue(), '', 'the successfully submitted, unchanged draft is cleared');
  await page.evaluate(() => document.dispatchEvent(new CustomEvent('attention-fixture', { detail: JSON.stringify({ error: 'Could not check your jobs. Please try again.' }) })));
  await page.getByRole('alert').waitFor();
  assert.equal(await notice.inputValue(), 'One month', 'a background refresh error cannot unmount unsaved answers');
  const base:QuestionControl={id:'part0',label:'Which clearance do you hold?',kind:'radio',required:true,multiple:false,constraints:{},choices:[{id:'choice0',label:'None',value:'none',disabled:false},{id:'choice1',label:'Baseline',value:'base',disabled:false},{id:'choice2',label:'NV2',value:'nv2',disabled:true}]};
  const snapshot=sealQuestionSnapshot({version:2,source:{origin:'https://employer.example',path:'/apply'},prompt:base.label,context:['Eligibility'],help:['Select your current clearance.'],controls:[base],completeness:'complete'});
  const update=async (questions:unknown[])=>page.evaluate(questions=>document.dispatchEvent(new CustomEvent('attention-fixture',{detail:JSON.stringify({error:null,items:[{jobId:'fixture-job',title:'Fixture role',company:'Fixture employer',kind:'question',reason:'',url:'https://example.test',at:'2026-10-30T00:00:00Z',questions}]})})),questions);
  await update([{question:snapshot.prompt,snapshot}]);
  assert.equal(await page.getByRole('radio').count(),3,'all original radio buttons are rendered');
  assert.equal(await page.getByRole('combobox').count(),0);
  assert.equal(await page.getByRole('textbox').count(),0,'finite choices never offer an invented free-text escape');
  assert.equal(await page.getByRole('radio',{name:'NV2',exact:true}).isDisabled(),true);
  await page.getByRole('radio',{name:'Baseline',exact:true}).check();
  mode='success';await page.getByRole('button',{name:'Save answers',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.saved==='2');
  assert.deepEqual(writes.at(-1)!.answers[0],{questionId:snapshot.id,revision:snapshot.revision,response:{part0:'choice1'}});
  const controls:QuestionControl[]=[{...base,kind:'date',label:'Available from',choices:[],constraints:{min:'2026-01-01',max:'2027-12-31'}},{...base,id:'part1',kind:'checkbox-group',label:'Regions',multiple:true},{...base,id:'part2',kind:'select',label:'Work patterns',multiple:true}];
  const complex=sealQuestionSnapshot({...snapshot,prompt:'Availability and preferences',controls});
  await update([{question:complex.prompt,snapshot:complex}]);
  const availableFrom=page.getByLabel('Available from',{exact:true});
  assert.equal(await availableFrom.getAttribute('type'),'date');
  assert.equal(await availableFrom.getAttribute('min'),'2026-01-01');
  assert.equal(await availableFrom.getAttribute('max'),'2027-12-31');
  await availableFrom.fill('2025-12-31');
  await page.getByRole('checkbox',{name:'None',exact:true}).check();
  await page.getByRole('checkbox',{name:'Baseline',exact:true}).check();
  await page.getByRole('listbox',{name:'Work patterns',exact:true}).selectOption(['choice0','choice1']);
  assert.equal(await page.getByRole('button',{name:'Save answers',exact:true}).isDisabled(),true,'native employer date limits apply to the saved response');
  await availableFrom.fill('2026-11-03');
  mkdirSync(resolve(import.meta.dirname,'../../output/attention-review'),{recursive:true});
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'original controls stay within desktop and mobile width');
    await page.screenshot({path:resolve(import.meta.dirname,`../../output/attention-review/controls-${width}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'Save answers',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.saved==='3');
  assert.deepEqual(writes.at(-1)!.answers[0].response,{part0:'2026-11-03',part1:['choice0','choice1'],part2:['choice0','choice1']});
  const birth=sealQuestionSnapshot({...snapshot,prompt:'date of birth optional',context:['register-form'],help:[],controls:[{...base,label:'date of birth optional',kind:'text',choices:[],constraints:{}}]});
  await update([{question:birth.prompt,snapshot:birth}]);
  const birthInput=page.getByLabel('date of birth optional',{exact:true});
  assert.equal(await birthInput.getAttribute('type'),'date','employer plain-text birth dates offer a native calendar');
  assert.equal(await birthInput.inputValue(),'','no personal date is guessed or preselected');
  assert.equal(await page.getByRole('button',{name:'Save answers',exact:true}).isDisabled(),true);
  await birthInput.fill('2000-02-29');
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:resolve(import.meta.dirname,`../../output/attention-review/birth-date-${width}.png`),fullPage:true});
  }
  await page.getByRole('button',{name:'Save answers',exact:true}).click();
  await page.waitForFunction(()=>document.documentElement.dataset.saved==='4');
  assert.deepEqual(writes.at(-1)!.answers[0],{questionId:birth.id,revision:birth.revision,response:{part0:'2000-02-29'}},'the selected leap date reaches the save API exactly, with the original text snapshot identity');
  const textBirth=sealQuestionSnapshot({...birth,controls:[{...birth.controls[0],constraints:{pattern:'[0-9]{2}/[0-9]{2}/[0-9]{4}'}}]});
  await update([{question:textBirth.prompt,snapshot:textBirth}]);
  assert.equal(await page.getByLabel(textBirth.prompt,{exact:true}).getAttribute('type'),'text','explicit employer date formats retain their original input');
  const place=sealQuestionSnapshot({...birth,prompt:'Place of birth',controls:[{...birth.controls[0],label:'Place of birth'}]});
  await update([{question:place.prompt,snapshot:place}]);
  assert.equal(await page.getByLabel(place.prompt,{exact:true}).getAttribute('type'),'text','birthplace is not a calendar date');
  const parts=sealQuestionSnapshot({...birth,prompt:'Date of birth',controls:['Month','Day','Year'].map((label,index)=>({...birth.controls[0],id:`part${index}`,label,constraints:{maxLength:index===2?4:2}}))});
  await update([{question:parts.prompt,snapshot:parts}]);
  const datePicker=page.getByLabel(parts.prompt,{exact:true});
  const save=page.getByRole('button',{name:'Save answers',exact:true});
  assert.equal(await page.locator('input').count(),1,'three employer text controls are presented as one date picker');
  assert.equal(await datePicker.getAttribute('type'),'date');
  assert.equal(await datePicker.inputValue(),'');
  assert.equal(await save.isDisabled(),true);
  const colors:string[]=[];
  for(const [theme,width] of [['light',1440],['dark',390]] as const){
    await page.setViewportSize({width,height:800});
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;},theme);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    colors.push(await datePicker.evaluate(input=>getComputedStyle(input).color));
    assert.equal(await datePicker.evaluate(input=>getComputedStyle(input).colorScheme),theme,'native calendar follows the dashboard theme');
  }
  assert.notEqual(colors[0],colors[1],'the calendar text follows light and dark themes');
  await datePicker.fill('2000-02-29');
  await save.click();
  await page.waitForFunction(()=>document.documentElement.dataset.saved==='5');
  assert.deepEqual(writes.at(-1),{jobId:'fixture-job',answers:[{questionId:parts.id,revision:parts.revision,response:{part0:'02',part1:'29',part2:'2000'}}]},'the save request keeps the original question identity and employer component values');
  const dateHeading='Date of Birth *';
  const separateParts=parts.controls.map(control=>sealQuestionSnapshot({
    ...parts,context:['Voluntary Disclosures','Personal Data',dateHeading],prompt:control.label,controls:[{...control,id:'part0'}],
  }));
  const dateQuestions=separateParts.map(snapshot=>({question:snapshot.prompt,snapshot}));
  await update(dateQuestions);
  const groupedPicker=page.getByLabel(dateHeading,{exact:true});
  assert.equal(await groupedPicker.getAttribute('type'),'date');
  assert.equal(await page.locator('input').count(),1,'three original single-control questions share one calendar when their employer context matches');
  assert.equal(await groupedPicker.inputValue(),'');
  assert.equal(await save.isDisabled(),true);
  await groupedPicker.fill('2004-01-09');
  await update(dateQuestions.slice(0,2));
  assert.equal(await page.locator('input[type=date]').count(),0,'partial sets fall back to the remaining original controls');
  assert.equal(await page.getByRole('textbox',{name:'Month',exact:true}).inputValue(),'01');
  assert.equal(await page.getByRole('textbox',{name:'Day',exact:true}).inputValue(),'09');
  await update(dateQuestions);
  assert.equal(await groupedPicker.inputValue(),'2004-01-09','refreshing the full group retains the existing draft');
  await save.click();
  await page.waitForFunction(()=>document.documentElement.dataset.saved==='6');
  assert.deepEqual(writes.at(-1),{jobId:'fixture-job',answers:separateParts.map((snapshot,index)=>({
    questionId:snapshot.id,revision:snapshot.revision,response:{part0:['01','09','2004'][index]},
  }))},'a grouped calendar saves each original question and its own part0 response');
  const otherYear=sealQuestionSnapshot({...separateParts[2],source:{...separateParts[2].source,path:'/other'}});
  await update([...dateQuestions.slice(0,2),{question:otherYear.prompt,snapshot:otherYear}]);
  assert.equal(await page.locator('input[type=date]').count(),0,'identically labelled controls from different sources stay separate');
  assert.equal(await page.getByRole('textbox').count(),3);
  await page.getByRole('textbox',{name:'Month',exact:true}).fill('02');
  await update(dateQuestions);
  assert.equal(await page.locator('input[type=date]').count(),0,'restoring the full group keeps a partial draft visible');
  assert.equal(await page.getByRole('textbox',{name:'Month',exact:true}).inputValue(),'02');
  const startDate=sealQuestionSnapshot({...birth,prompt:'Earliest start date',controls:[{...birth.controls[0],label:'Earliest start date'}]});
  await update([{question:startDate.prompt,snapshot:startDate}]);
  assert.equal(await page.getByLabel(startDate.prompt,{exact:true}).getAttribute('type'),'date');
  const patternedParts=sealQuestionSnapshot({...parts,controls:parts.controls.map(c=>c.label==='Year'?{...c,constraints:{...c.constraints,pattern:'[0-9]{4}'}}:c)});
  await update([{question:patternedParts.prompt,snapshot:patternedParts}]);
  assert.equal(await page.getByRole('textbox').count(),3,'employer-formatted date components retain their original inputs');
  await update([{question:'Month',kind:'text'}]);
  await page.getByText("Open the application to check the employer's original question before answering.").waitFor();
  assert.equal(await page.getByRole('textbox').count(),0,'legacy fragments are not represented as complete questions');
  assert.equal(await page.getByRole('button',{name:'Save answers',exact:true}).count(),0);
  await update([{question:snapshot.prompt,snapshot:{...snapshot,completeness:'recapture'}}]);
  assert.equal(await page.getByRole('radio').count(),0,'incomplete catalogs cannot collect partial answers');
  const diagnostic='ARBITRARY_FUTURE_DIAGNOSTIC specialist f7 operation_json selector #broken';
  for(const admin of [false,true]){
    await page.evaluate(({admin,diagnostic})=>document.dispatchEvent(new CustomEvent('attention-fixture',{detail:JSON.stringify({admin,error:diagnostic,items:[{jobId:'fixture-job',title:'Fixture role',company:'Fixture employer',kind:'question',reason:diagnostic,url:'https://example.test',at:'2026-10-30T00:00:00Z',questions:[{question:diagnostic,prompt:diagnostic}]}]})})),{admin,diagnostic});
    await page.getByText("Open the application to check the employer's original question before answering.").waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(diagnostic),'legacy prompts, reasons and refresh errors never render diagnostics for either role');
    assert.equal(await page.getByRole('button',{name:'View steps',exact:true}).count(),0,'Needs attention has no diagnostic trace expansion');
  }
  const apiQuestion=sealQuestionSnapshot({...snapshot,prompt:'Describe your API debugging experience.',controls:[{...base,label:'Describe your API debugging experience.',kind:'textarea',choices:[]}]});
  await update([{question:diagnostic,prompt:diagnostic,snapshot:apiQuestion}]);
  assert.equal(await page.getByRole('textbox',{name:apiQuestion.prompt,exact:true}).count(),1,'original employer technical wording is preserved without a jargon blacklist');
  assert.ok(!(await page.locator('body').innerText()).includes(diagnostic));
  console.log('PASS: repeated captions, save failures, malformed success, in-flight edits, refresh errors and typed original controls retain correct candidate drafts. Fixture only.');
} finally {
  await browser?.close();
  await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
}
